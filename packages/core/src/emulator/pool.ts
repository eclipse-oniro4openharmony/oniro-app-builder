import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { getEmulatorDir } from '../sdk/paths.js';
import { hdcExec, runProcess, shell } from '../hdc/exec.js';
import {
  DEFAULT_EMULATOR_PID_FILE,
  assertPoolInstance,
  isInstanceProcess,
  listPoolInstanceNumbers,
  poolInstanceDir,
  readDefaultEmulatorPid,
  readPoolState,
  writePoolState,
  type BaseImageFingerprint,
  type PoolInstanceState,
} from './state.js';

/**
 * Health of one emulator instance:
 * - `stopped`: no QEMU process.
 * - `booting`: QEMU is alive; hdc cannot reach the guest yet, or `bootevent.boot.completed` is not `true`.
 * - `ready`: `hdc shell param get bootevent.boot.completed` answers `true`.
 * - `hdc-lost`: the instance was ready during this boot and hdc can no longer reach it.
 * - `stuck`: QEMU is alive but the boot has not completed within the instance's boot timeout.
 */
export type EmulatorHealth = 'stopped' | 'booting' | 'ready' | 'hdc-lost' | 'stuck';

/** Ports of pool instance `n`: hdc 55555+n, VNC display n (5900+n), telnet serial 4444+n. */
export interface PoolInstancePorts {
  hdc: number;
  vncDisplay: number;
  vnc: number;
  serial: number;
}

export function poolInstancePorts(n: number): PoolInstancePorts {
  assertPoolInstance(n);
  return { hdc: 55555 + n, vncDisplay: n, vnc: 5900 + n, serial: 4444 + n };
}

/** The writable disks run.sh attaches, in its order (the guest sees them as vda..vdd). */
export const POOL_DISKS = ['updater', 'system', 'vendor', 'userdata'] as const;

/** Every file a pool instance needs in `<emulatorDir>/images`. */
export const POOL_REQUIRED_IMAGES = ['bzImage', 'ramdisk.img', ...POOL_DISKS.map((d) => `${d}.img`)] as const;

/** run.sh's kernel command line, verbatim. */
export const EMULATOR_KERNEL_APPEND =
  'ip=dhcp loglevel=4 console=ttyS0,115200 init=init root=/dev/ram0 rw ohos.boot.hardware=x86_general ' +
  'ohos.required_mount.system=/dev/block/vdb@/usr@ext4@ro,barrier=1@wait,required ' +
  'ohos.required_mount.vendor=/dev/block/vdc@/vendor@ext4@ro,barrier=1@wait,required ' +
  'ohos.required_mount.misc=/dev/block/vda@/misc@none@none=@wait,required';

/** Pool defaults: smaller than run.sh's 6 CPUs / 4 GB so several instances fit on one host. */
export const POOL_DEFAULT_SMP = 2;
export const POOL_DEFAULT_MEMORY = '2048M';
export const POOL_DEFAULT_RESOLUTION = '360x720';
/** Seconds after launch past which a boot that has not completed counts as `stuck`. */
export const DEFAULT_BOOT_TIMEOUT_SECONDS = 300;

export type EmulatorAccel = 'auto' | 'kvm' | 'hvf' | 'whpx' | 'tcg';

/**
 * QEMU accelerator and CPU arguments, chosen as run.sh chooses them: KVM on Linux,
 * HVF on an x86_64 Mac, TCG on Apple Silicon, WHPX on Windows. Pure/testable.
 */
export function emulatorAccelArgs(
  accel: EmulatorAccel = 'auto',
  platform: NodeJS.Platform = os.platform(),
  arch: string = os.arch(),
): string[] {
  const resolved: Exclude<EmulatorAccel, 'auto'> =
    accel !== 'auto'
      ? accel
      : platform === 'linux'
        ? 'kvm'
        : platform === 'darwin'
          ? arch === 'x64' ? 'hvf' : 'tcg'
          : platform === 'win32'
            ? 'whpx'
            : 'tcg';
  switch (resolved) {
    case 'kvm':
      return ['-enable-kvm', '-cpu', 'host'];
    case 'hvf':
      return ['-accel', 'hvf', '-cpu', 'host'];
    case 'whpx':
      return ['-accel', 'whpx'];
    case 'tcg':
      return ['-accel', 'tcg,thread=multi', '-cpu', 'max'];
  }
}

/** A QEMU option value with its commas doubled, as `-drive file=` requires. */
function qemuOptValue(v: string): string {
  return v.replace(/,/g, ',,');
}

export interface PoolQemuSpec {
  instance: number;
  /** The instance's state directory, holding `<disk>.qcow2`. */
  dir: string;
  /** `<emulatorDir>/images`, holding bzImage and ramdisk.img. */
  imagesDir: string;
  smp: number;
  memory: string;
  resolution: string;
  headless: boolean;
  /** `es1370` or `ES1370`, whichever this QEMU names it. */
  audioDevice: string;
  accelArgs: readonly string[];
  ports: PoolInstancePorts;
}

/**
 * The QEMU command line of a pool instance: run.sh's (q35, kernel/initrd/append,
 * four virtio-blk disks in the same order, virtio-gpu, user networking forwarding
 * the guest's hdcd port 55555) with the disks replaced by the instance's qcow2
 * overlays and every host port bound to 127.0.0.1 at the instance's own number.
 * Audio goes to a `none` backend so instances do not compete for the host's sound
 * server. Pure/testable.
 */
export function buildPoolQemuArgs(spec: PoolQemuSpec): string[] {
  const [w, h] = parseResolution(spec.resolution);
  const display = [
    '-nographic',
    '-vga', 'none',
    '-device', `virtio-gpu-pci,xres=${w},yres=${h},max_outputs=1,addr=08.0`,
    '-display', spec.headless ? `vnc=127.0.0.1:${spec.ports.vncDisplay}` : 'sdl,gl=off',
  ];
  const drives = POOL_DISKS.flatMap((d, i) => [
    '-drive', `if=none,file=${qemuOptValue(path.join(spec.dir, `${d}.qcow2`))},format=qcow2,id=${d},index=${i}`,
    '-device', `virtio-blk-pci,drive=${d}`,
  ]);
  return [
    '-name', `oniro-pool-${spec.instance}`,
    '-machine', 'q35',
    '-smp', String(spec.smp),
    '-m', spec.memory,
    '-boot', 'c',
    ...display,
    '-rtc', 'base=utc,clock=host',
    '-audiodev', 'none,id=snd0',
    '-device', `${spec.audioDevice},audiodev=snd0`,
    '-initrd', path.join(spec.imagesDir, 'ramdisk.img'),
    '-kernel', path.join(spec.imagesDir, 'bzImage'),
    ...drives,
    '-serial', `telnet:127.0.0.1:${spec.ports.serial},server,nowait`,
    '-append', EMULATOR_KERNEL_APPEND,
    ...spec.accelArgs,
    '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${spec.ports.hdc}-:55555`,
    '-device', 'virtio-net-pci,netdev=net0',
  ];
}

function parseResolution(res: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(res);
  if (!m) throw new OniroError(`Resolution must be WxH (e.g. 360x720), got '${res}'.`);
  return [Number(m[1]), Number(m[2])];
}

/** Inputs to {@link classifyEmulatorHealth}. */
export interface HealthInputs {
  /** QEMU is alive. */
  alive: boolean;
  /** hdc ran a shell command on the guest. */
  hdcReachable: boolean;
  /** `bootevent.boot.completed` is `true`. */
  bootCompleted: boolean;
  /** This boot has been seen ready before. */
  wasReady: boolean;
  /** Milliseconds since QEMU was launched, when known. */
  elapsedMs?: number;
  bootTimeoutMs: number;
}

/** The health code for one probe. Pure/testable. */
export function classifyEmulatorHealth(i: HealthInputs): EmulatorHealth {
  if (!i.alive) return 'stopped';
  if (i.hdcReachable && i.bootCompleted) return 'ready';
  if (i.wasReady) return i.hdcReachable ? 'booting' : 'hdc-lost';
  if (i.elapsedMs !== undefined && i.elapsedMs > i.bootTimeoutMs) return 'stuck';
  return 'booting';
}

export interface HdcBootProbe {
  hdcReachable: boolean;
  bootCompleted: boolean;
}

/**
 * Ask the guest at `address` whether it has booted: `hdc tconn <address>` (which
 * adds the target to the running hdc server, never restarting it), then
 * `hdc -t <address> shell param get bootevent.boot.completed`.
 */
export async function probeEmulatorBoot(
  config: ConfigProvider,
  address: string,
  opts: { logger?: Logger; timeoutMs?: number } = {},
): Promise<HdcBootProbe> {
  const logger = opts.logger ?? noopLogger;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    await hdcExec({ config, args: ['tconn', address], timeoutMs, logger });
  } catch {
    // Reported by the shell probe below.
  }
  try {
    const res = await shell({ config, command: 'param get bootevent.boot.completed', deviceSerial: address, timeoutMs, logger });
    if (res.code !== 0) return { hdcReachable: false, bootCompleted: false };
    return { hdcReachable: true, bootCompleted: res.stdout.trim() === 'true' };
  } catch {
    return { hdcReachable: false, bootCompleted: false };
  }
}

/** One instance as `emulator status` reports it. */
export interface EmulatorInstanceStatus {
  /** 0 is the default emulator (run.sh); 1.. are pool instances. */
  instance: number;
  state: EmulatorHealth;
  /** hdc serial: `127.0.0.1:<hdcPort>`. */
  address: string;
  hdcPort: number;
  /** VNC TCP port (headless pool instances). */
  vncPort?: number;
  /** Telnet serial console port (pool instances). */
  serialPort?: number;
  pid?: number;
  hdcReachable: boolean;
  bootCompleted: boolean;
  /** Pool instance state directory (overlays, instance.json, qemu.log). */
  dir?: string;
  logFile?: string;
  memory?: string;
  smp?: number;
  headless?: boolean;
  startedAt?: string;
  readyAt?: string;
  /** Seconds from launch to the first `ready` of this boot. */
  bootSeconds?: number;
}

function bootSeconds(state: { startedAt?: string; readyAt?: string }): number | undefined {
  if (!state.startedAt || !state.readyAt) return undefined;
  return Math.round((Date.parse(state.readyAt) - Date.parse(state.startedAt)) / 1000);
}

/**
 * Status of pool instance `n`, probing hdc when QEMU is alive. Records the first
 * `ready` (and a later loss of hdc) in the instance's `instance.json`, which is what
 * tells `hdc-lost` apart from `booting`.
 */
export async function getPoolInstanceStatus(
  config: ConfigProvider,
  n: number,
  opts: { logger?: Logger; probeTimeoutMs?: number } = {},
): Promise<EmulatorInstanceStatus> {
  const dir = poolInstanceDir(config, n);
  const ports = poolInstancePorts(n);
  const address = `127.0.0.1:${ports.hdc}`;
  const state = readPoolState(dir);
  const base: EmulatorInstanceStatus = {
    instance: n,
    state: 'stopped',
    address,
    hdcPort: ports.hdc,
    serialPort: ports.serial,
    hdcReachable: false,
    bootCompleted: false,
    dir,
  };
  if (!state) return base;
  const withState: EmulatorInstanceStatus = {
    ...base,
    vncPort: state.headless ? 5900 + state.vncDisplay : undefined,
    logFile: state.logFile,
    memory: state.memory,
    smp: state.smp,
    headless: state.headless,
  };
  const alive = isInstanceProcess(state.pid, dir);
  if (!alive) return withState;

  const probe = await probeEmulatorBoot(config, address, { logger: opts.logger, timeoutMs: opts.probeTimeoutMs });
  const elapsedMs = state.startedAt ? Date.now() - Date.parse(state.startedAt) : undefined;
  const health = classifyEmulatorHealth({
    alive,
    ...probe,
    wasReady: state.readyAt !== undefined,
    elapsedMs,
    bootTimeoutMs: (state.bootTimeoutSeconds ?? DEFAULT_BOOT_TIMEOUT_SECONDS) * 1000,
  });
  // Re-read before writing, so a concurrent `stop` that cleared the PID is not undone.
  const latest = readPoolState(dir);
  if (latest && latest.pid === state.pid) {
    let changed = false;
    if (health === 'ready' && !latest.readyAt) {
      latest.readyAt = new Date().toISOString();
      changed = true;
    }
    if (health === 'ready' && latest.lostAt) {
      delete latest.lostAt;
      changed = true;
    }
    if (health === 'hdc-lost' && !latest.lostAt) {
      latest.lostAt = new Date().toISOString();
      changed = true;
    }
    if (changed) writePoolState(dir, latest);
    Object.assign(state, latest);
  }
  return {
    ...withState,
    state: health,
    pid: state.pid,
    hdcReachable: probe.hdcReachable,
    bootCompleted: probe.bootCompleted,
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    bootSeconds: bootSeconds(state),
  };
}

/** Status of every pool instance that has a state directory, probed in parallel. */
export async function listPoolInstanceStatuses(
  config: ConfigProvider,
  opts: { logger?: Logger; probeTimeoutMs?: number } = {},
): Promise<EmulatorInstanceStatus[]> {
  return Promise.all(listPoolInstanceNumbers(config).map((n) => getPoolInstanceStatus(config, n, opts)));
}

/**
 * Status of the default emulator (instance 0, launched by run.sh). Without a record
 * of an earlier `ready`, it is never `hdc-lost`; `stuck` counts from the PID file's
 * mtime, i.e. the launch.
 */
export async function getDefaultInstanceStatus(
  config: ConfigProvider,
  opts: { running: boolean; address?: string; logger?: Logger; probeTimeoutMs?: number; bootTimeoutSeconds?: number },
): Promise<EmulatorInstanceStatus> {
  const address = opts.address ?? '127.0.0.1:55555';
  const port = Number(address.split(':').pop());
  const pid = readDefaultEmulatorPid();
  const status: EmulatorInstanceStatus = {
    instance: 0,
    state: 'stopped',
    address,
    hdcPort: port,
    pid,
    hdcReachable: false,
    bootCompleted: false,
  };
  if (!opts.running) return status;
  let startedAtMs: number | undefined;
  if (pid) {
    try {
      startedAtMs = fs.statSync(DEFAULT_EMULATOR_PID_FILE).mtimeMs;
    } catch {
      // No launch time: never `stuck`.
    }
  }
  const probe = await probeEmulatorBoot(config, address, { logger: opts.logger, timeoutMs: opts.probeTimeoutMs });
  return {
    ...status,
    ...probe,
    startedAt: startedAtMs !== undefined ? new Date(startedAtMs).toISOString() : undefined,
    state: classifyEmulatorHealth({
      alive: true,
      ...probe,
      wasReady: false,
      elapsedMs: startedAtMs !== undefined ? Date.now() - startedAtMs : undefined,
      bootTimeoutMs: (opts.bootTimeoutSeconds ?? DEFAULT_BOOT_TIMEOUT_SECONDS) * 1000,
    }),
  };
}

/** Whether `port` can be bound on `host` right now. */
export function isTcpPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** `qemu-img` next to `qemuBin` when that is a path, else from PATH. */
function defaultQemuImg(qemuBin: string): string {
  const exe = os.platform() === 'win32' ? 'qemu-img.exe' : 'qemu-img';
  if (qemuBin.includes('/') || qemuBin.includes('\\')) {
    const sibling = path.join(path.dirname(qemuBin), exe);
    if (fs.existsSync(sibling)) return sibling;
  }
  return 'qemu-img';
}

/** How this QEMU names the ES1370 sound card (`es1370` since QEMU 2.x, `ES1370` before). */
async function detectAudioDevice(qemuBin: string, logger: Logger): Promise<string> {
  try {
    const res = await runProcess({ command: qemuBin, args: ['-device', 'help'], timeoutMs: 20_000, logger });
    return /"es1370"/.test(`${res.stdout}${res.stderr}`) ? 'es1370' : 'ES1370';
  } catch (err) {
    throw new OniroError(
      `Could not run ${qemuBin}: ${(err as Error).message}. Install QEMU (Debian/Ubuntu: sudo apt install ` +
        'qemu-system-x86 qemu-utils) or pass --qemu <path>.',
      err,
    );
  }
}

function fingerprint(file: string): BaseImageFingerprint {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

/**
 * Make sure `dir` holds a qcow2 overlay per disk, backed read-only by the raw image
 * in `imagesDir`. Overlays are created with `-u` (the backing file is not opened),
 * so this works even while something else holds the base images. An existing set is
 * reused unless a base image changed since it was made (instance 0 booted and wrote
 * to it, or the emulator was reinstalled), which would corrupt the overlay.
 */
async function ensureOverlays(opts: {
  dir: string;
  imagesDir: string;
  qemuImg: string;
  state: PoolInstanceState | undefined;
  instance: number;
  logger: Logger;
}): Promise<Record<string, BaseImageFingerprint>> {
  const { dir, imagesDir, qemuImg, state, logger } = opts;
  const overlays = POOL_DISKS.map((d) => path.join(dir, `${d}.qcow2`));
  const current: Record<string, BaseImageFingerprint> = {};
  for (const d of POOL_DISKS) current[`${d}.img`] = fingerprint(path.join(imagesDir, `${d}.img`));

  const complete = overlays.every((o) => fs.existsSync(o)) && state?.bases !== undefined;
  if (complete) {
    const changed = Object.keys(current).filter(
      (k) => state!.bases![k]?.size !== current[k]!.size || state!.bases![k]?.mtimeMs !== current[k]!.mtimeMs,
    );
    if (changed.length === 0) return state!.bases!;
    throw new OniroError(
      `Base image(s) ${changed.join(', ')} in ${imagesDir} changed since instance ${opts.instance}'s overlays were ` +
        'created (the default emulator ran, or the emulator was reinstalled), so the overlays no longer match. ' +
        `Start it again with --fresh to discard them.`,
    );
  }

  for (const o of overlays) fs.rmSync(o, { force: true });
  for (const d of POOL_DISKS) {
    const base = path.join(imagesDir, `${d}.img`);
    const overlay = path.join(dir, `${d}.qcow2`);
    const res = await runProcess({
      command: qemuImg,
      args: ['create', '-q', '-f', 'qcow2', '-F', 'raw', '-b', base, '-u', overlay, String(current[`${d}.img`]!.size)],
      timeoutMs: 60_000,
      logger,
    }).catch((err: Error) => {
      throw new OniroError(
        `Could not run ${qemuImg}: ${err.message}. Install it (Debian/Ubuntu: sudo apt install qemu-utils).`,
        err,
      );
    });
    if (res.code !== 0) {
      throw new OniroError(`qemu-img could not create ${overlay}: ${(res.stderr || res.stdout).trim()}`);
    }
  }
  logger.info(`Created copy-on-write overlays in ${dir}.`);
  return current;
}

export function readLogTail(filePath: string, bytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export interface StartPoolInstanceOptions {
  config: ConfigProvider;
  /** Pool instance number, 1..99. */
  instance: number;
  logger?: Logger;
  /** Virtual CPUs. Default {@link POOL_DEFAULT_SMP}. */
  smp?: number;
  /** RAM in QEMU's `-m` syntax. Default {@link POOL_DEFAULT_MEMORY}. */
  memory?: string;
  /** Display resolution, WxH. Default {@link POOL_DEFAULT_RESOLUTION}. */
  resolution?: string;
  /** VNC on 127.0.0.1:590n instead of a local SDL window. Default true. */
  headless?: boolean;
  /** Discard the instance's overlays first: a factory reset. */
  fresh?: boolean;
  /** Seconds after launch past which a boot that has not completed is `stuck`. Default 300. */
  bootTimeoutSeconds?: number;
  /** If > 0, wait up to this many seconds for `ready`. */
  waitReadySeconds?: number;
  /** Poll interval of that wait, ms. Default 5000. */
  pollIntervalMs?: number;
  /** QEMU binary. Default `QEMU_BIN`, else `qemu-system-x86_64` from PATH. */
  qemuBin?: string;
  /** qemu-img binary. Default: next to `qemuBin`, else from PATH. */
  qemuImg?: string;
  /** Accelerator. Default `auto` (KVM on Linux, as run.sh). */
  accel?: EmulatorAccel;
  /** QEMU's stdout/stderr. Default `<instance dir>/qemu.log`. */
  logFile?: string;
  /** How long QEMU must stay up after launch before it counts as started, ms. Default 2000. */
  earlyExitWindowMs?: number;
  abortSignal?: AbortSignal;
}

/**
 * Launch pool instance `n` (n >= 1): its own QEMU, detached, on copy-on-write
 * overlays of the bundled images, with hdc forwarded from 127.0.0.1:55555+n, VNC
 * on display n and the serial console on telnet 4444+n. The default emulator
 * (run.sh, instance 0) opens the same images read-write, so the two cannot run at
 * once; that is checked up front. If the instance is already running, nothing is
 * launched. Connects hdc with `hdc tconn` only; the hdc server is never restarted.
 */
export async function startPoolInstance(opts: StartPoolInstanceOptions): Promise<EmulatorInstanceStatus> {
  const { config, instance: n } = opts;
  const logger = opts.logger ?? noopLogger;
  assertPoolInstance(n);
  const ports = poolInstancePorts(n);
  const dir = poolInstanceDir(config, n);
  const imagesDir = path.join(getEmulatorDir(config), 'images');
  const headless = opts.headless ?? true;
  const smp = opts.smp ?? POOL_DEFAULT_SMP;
  const memory = opts.memory ?? POOL_DEFAULT_MEMORY;
  const resolution = opts.resolution ?? POOL_DEFAULT_RESOLUTION;
  parseResolution(resolution);
  if (!Number.isInteger(smp) || smp < 1) throw new OniroError(`--smp must be a positive integer, got ${smp}.`);
  if (!/^\d+[KMGT]?$/i.test(memory)) throw new OniroError(`--memory must look like 2048M or 2G, got '${memory}'.`);
  const qemuBin = opts.qemuBin ?? process.env.QEMU_BIN ?? 'qemu-system-x86_64';
  const qemuImg = opts.qemuImg ?? defaultQemuImg(qemuBin);
  const wait = (): Promise<EmulatorInstanceStatus> =>
    waitPoolInstanceReady({
      config,
      instance: n,
      timeoutSeconds: opts.waitReadySeconds!,
      pollIntervalMs: opts.pollIntervalMs,
      logger,
      abortSignal: opts.abortSignal,
    });

  const prior = readPoolState(dir);
  if (prior && isInstanceProcess(prior.pid, dir)) {
    if (opts.fresh) {
      throw new OniroError(`Instance ${n} is running (PID ${prior.pid}); stop it before --fresh: oniro-app emulator stop --instance ${n}`);
    }
    logger.info(`Instance ${n} already running (PID ${prior.pid}); not starting another.`);
    if (opts.waitReadySeconds && opts.waitReadySeconds > 0) return wait();
    return getPoolInstanceStatus(config, n, { logger });
  }

  const missing = POOL_REQUIRED_IMAGES.filter((f) => !fs.existsSync(path.join(imagesDir, f)));
  if (missing.includes('bzImage') && fs.existsSync(path.join(imagesDir, 'Image'))) {
    throw new OniroError(
      'Pool instances run the x86_64 emulator only, and the installed one is arm64. Start it without ' +
        '--instance, or install the x86_64 emulator with `oniro-app emulator install --force --arch x86_64`.',
    );
  }
  if (missing.length > 0) {
    throw new OniroError(
      `Missing emulator image(s) in ${imagesDir}: ${missing.join(', ')}. Run \`oniro-app emulator install\` first.`,
    );
  }

  const defaultPid = readDefaultEmulatorPid();
  if (defaultPid) {
    throw new OniroError(
      `The default emulator (instance 0, PID ${defaultPid}) is running. It opens the base images read-write, so ` +
        'QEMU will not let a pool instance use them as backing files (and its writes would corrupt the overlays). ' +
        'Stop it first.',
    );
  }

  const busy: string[] = [];
  if (!(await isTcpPortFree(ports.hdc))) busy.push(`hdc ${ports.hdc}`);
  if (!(await isTcpPortFree(ports.serial))) busy.push(`serial ${ports.serial}`);
  if (headless && !(await isTcpPortFree(ports.vnc))) busy.push(`VNC ${ports.vnc} (display :${ports.vncDisplay})`);
  if (busy.length > 0) {
    throw new OniroError(
      `Instance ${n}'s port(s) are taken on 127.0.0.1: ${busy.join(', ')}. Pick another instance number, or free them.`,
    );
  }

  const accelArgs = emulatorAccelArgs(opts.accel);
  if (accelArgs[0] === '-enable-kvm' && !fs.existsSync('/dev/kvm')) {
    throw new OniroError('/dev/kvm is not available: enable virtualization in the BIOS and load kvm-intel/kvm-amd, or pass --accel tcg (slow).');
  }
  if (accelArgs[0] === '-enable-kvm') {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      throw new OniroError('Cannot access /dev/kvm: add yourself to the kvm group (sudo usermod -aG kvm $USER, then log in again).');
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  if (opts.fresh) {
    for (const d of POOL_DISKS) fs.rmSync(path.join(dir, `${d}.qcow2`), { force: true });
    logger.info(`Discarded instance ${n}'s overlays (--fresh).`);
  }
  const bases = await ensureOverlays({ dir, imagesDir, qemuImg, state: opts.fresh ? undefined : prior, instance: n, logger });
  const audioDevice = await detectAudioDevice(qemuBin, logger);
  const args = buildPoolQemuArgs({ instance: n, dir, imagesDir, smp, memory, resolution, headless, audioDevice, accelArgs, ports });

  const logFile = opts.logFile ?? path.join(dir, 'qemu.log');
  const logFd = fs.openSync(logFile, 'w');
  let child;
  try {
    child = spawn(qemuBin, args, { cwd: dir, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
  } finally {
    fs.closeSync(logFd);
  }
  const earlyExit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });
  if (!child.pid) {
    await earlyExit;
    throw new OniroError(`Failed to spawn ${qemuBin}. Install QEMU or pass --qemu <path>.`);
  }
  const state: PoolInstanceState = {
    instance: n,
    pid: child.pid,
    hdcPort: ports.hdc,
    vncDisplay: ports.vncDisplay,
    serialPort: ports.serial,
    memory,
    smp,
    resolution,
    headless,
    bootTimeoutSeconds: opts.bootTimeoutSeconds ?? DEFAULT_BOOT_TIMEOUT_SECONDS,
    startedAt: new Date().toISOString(),
    logFile,
    bases,
  };
  writePoolState(dir, state);
  child.unref();
  logger.info(
    `Instance ${n} launched (PID ${child.pid}, ${smp} CPUs, ${memory}): hdc 127.0.0.1:${ports.hdc}` +
      (headless ? `, VNC 127.0.0.1:${ports.vnc}` : '') +
      `, serial telnet 127.0.0.1:${ports.serial}. Log: ${logFile}`,
  );

  const outcome = await Promise.race([earlyExit, new Promise<'alive'>((r) => setTimeout(() => r('alive'), opts.earlyExitWindowMs ?? 2000))]);
  if (outcome !== 'alive') {
    delete state.pid;
    writePoolState(dir, state);
    const tail = readLogTail(logFile, 4000);
    const lockHint = /lock/i.test(tail)
      ? '\nAnother QEMU holds the base images read-write (the default emulator?). Stop it first.'
      : '';
    throw new OniroError(`QEMU for instance ${n} exited with code ${outcome} right after launch. Tail of ${logFile}:\n${tail}${lockHint}`);
  }

  if (opts.waitReadySeconds && opts.waitReadySeconds > 0) return wait();
  return getPoolInstanceStatus(config, n, { logger });
}

export interface WaitPoolInstanceReadyOptions {
  config: ConfigProvider;
  instance: number;
  timeoutSeconds: number;
  /** Default 5000. */
  pollIntervalMs?: number;
  logger?: Logger;
  abortSignal?: AbortSignal;
}

/**
 * Poll pool instance `n` until it is `ready`. Throws when QEMU exits (with the log
 * tail) or the timeout passes.
 */
export async function waitPoolInstanceReady(opts: WaitPoolInstanceReadyOptions): Promise<EmulatorInstanceStatus> {
  const logger = opts.logger ?? noopLogger;
  const pollMs = opts.pollIntervalMs ?? 5000;
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let last: EmulatorInstanceStatus | undefined;
  let polls = 0;
  for (;;) {
    if (opts.abortSignal?.aborted) throw new CancelledError('Wait for the emulator cancelled.');
    last = await getPoolInstanceStatus(opts.config, opts.instance, { logger: noopLogger });
    polls++;
    if (last.state === 'ready') {
      logger.info(`Instance ${opts.instance} ready${last.bootSeconds !== undefined ? ` (booted in ${last.bootSeconds}s)` : ''}.`);
      return last;
    }
    if (last.state === 'stopped') {
      const tail = last.logFile ? readLogTail(last.logFile, 3000) : '';
      throw new OniroError(`Instance ${opts.instance} stopped while booting.${tail ? `\nTail of ${last.logFile}:\n${tail}` : ''}`);
    }
    if (Date.now() >= deadline) break;
    if (polls % 6 === 0) logger.info(`Instance ${opts.instance}: ${last.state} (${Math.ceil((deadline - Date.now()) / 1000)}s left).`);
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  throw new OniroError(
    `Instance ${opts.instance} not ready within ${opts.timeoutSeconds}s (state: ${last?.state}). ` +
      `It keeps running; see ${last?.logFile ?? 'its log'} and the serial console (telnet 127.0.0.1 ${last?.serialPort}).`,
  );
}

export interface StopPoolInstanceOptions {
  config: ConfigProvider;
  instance: number;
  /** Also delete the instance's directory: overlays, log and state. */
  discard?: boolean;
  logger?: Logger;
  /** How long to wait for QEMU to exit after SIGTERM before SIGKILL, ms. Default 15000. */
  killTimeoutMs?: number;
}

/**
 * Stop pool instance `n`: signal only its own QEMU (by the PID it recorded, checked
 * against the instance directory on Linux), drop its target from the hdc server with
 * `hdc tconn <address> -remove`, and with `discard` delete its overlays. Other
 * instances, the default emulator and every other QEMU are left alone. Resolves to
 * whether a running QEMU was stopped.
 */
export async function stopPoolInstance(opts: StopPoolInstanceOptions): Promise<boolean> {
  const { config, instance: n } = opts;
  const logger = opts.logger ?? noopLogger;
  const dir = poolInstanceDir(config, n);
  const state = readPoolState(dir);
  let stopped = false;
  if (state) {
    // hdc only drops a target it can still reach: an Offline one answers
    // `[Fail]No target available`. So this goes first, while the guest is up.
    try {
      await hdcExec({ config, args: ['tconn', `127.0.0.1:${state.hdcPort}`, '-remove'], timeoutMs: 10_000, logger });
    } catch {
      // No hdc, or the target was never listed.
    }
  }
  if (state?.pid && isInstanceProcess(state.pid, dir)) {
    const pid = state.pid;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      logger.warn(`Could not signal PID ${pid}: ${(err as Error).message}`);
    }
    const deadline = Date.now() + (opts.killTimeoutMs ?? 15_000);
    while (isInstanceProcess(pid, dir) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (isInstanceProcess(pid, dir)) {
      logger.warn(`Instance ${n} (PID ${pid}) ignored SIGTERM; sending SIGKILL.`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    stopped = true;
    logger.info(`Stopped instance ${n} (PID ${pid}).`);
  }
  if (state) {
    if (!opts.discard) {
      delete state.pid;
      delete state.readyAt;
      delete state.lostAt;
      writePoolState(dir, state);
    }
  }
  if (opts.discard && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.rmdirSync(path.dirname(dir)); // `instances/`, once the last instance is gone
    } catch {
      // Other instances remain.
    }
    logger.info(`Removed instance ${n}'s overlays and state (${dir}).`);
  }
  return stopped;
}
