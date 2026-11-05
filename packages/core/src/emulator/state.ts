import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import { getEmulatorDir } from '../sdk/paths.js';

/**
 * PID file of the default emulator (instance 0), the one `startEmulator` launches
 * through the bundled run.sh/run.bat.
 */
export const DEFAULT_EMULATOR_PID_FILE = path.join(os.tmpdir(), 'oniro_emulator.pid');

/** Highest pool instance number `--instance` accepts. */
export const MAX_POOL_INSTANCE = 99;

/** Whether a process with this PID exists (signal 0 probes without signalling). */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The PID of the default emulator (instance 0) when its PID file names a live process. */
export function readDefaultEmulatorPid(pidFile = DEFAULT_EMULATOR_PID_FILE): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return isPidAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Throw unless `n` is a pool instance number (1..{@link MAX_POOL_INSTANCE}). */
export function assertPoolInstance(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_POOL_INSTANCE) {
    throw new RangeError(`Pool instance must be an integer from 1 to ${MAX_POOL_INSTANCE}, got ${n}.`);
  }
}

/** Where pool instances keep their state: `<emulatorDir>/instances`. */
export function poolRootDir(config: ConfigProvider): string {
  return path.join(getEmulatorDir(config), 'instances');
}

/** State directory of pool instance `n`: overlays, `instance.json`, `qemu.log`. */
export function poolInstanceDir(config: ConfigProvider, n: number): string {
  assertPoolInstance(n);
  return path.join(poolRootDir(config), String(n));
}

/** Size and mtime of a base image when its overlay was created; a change means the overlay is stale. */
export interface BaseImageFingerprint {
  size: number;
  mtimeMs: number;
}

/** What `instance.json` records about a pool instance. */
export interface PoolInstanceState {
  instance: number;
  /** QEMU's PID while it runs. */
  pid?: number;
  hdcPort: number;
  vncDisplay: number;
  serialPort: number;
  memory: string;
  smp: number;
  resolution: string;
  headless: boolean;
  /** Seconds after `startedAt` past which a boot that never reached `ready` is `stuck`. */
  bootTimeoutSeconds: number;
  /** ISO time QEMU was launched. */
  startedAt?: string;
  /** ISO time this boot was first seen ready (`bootevent.boot.completed=true`). */
  readyAt?: string;
  /** ISO time hdc was first seen unable to reach the instance after it had been ready. */
  lostAt?: string;
  logFile: string;
  /** Base image name (e.g. `userdata.img`) → fingerprint at overlay creation. */
  bases?: Record<string, BaseImageFingerprint>;
}

export function stateFile(dir: string): string {
  return path.join(dir, 'instance.json');
}

export function readPoolState(dir: string): PoolInstanceState | undefined {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')) as PoolInstanceState;
  } catch {
    return undefined;
  }
}

export function writePoolState(dir: string, state: PoolInstanceState): void {
  const file = stateFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Whether `pid` is the QEMU of the instance in `dir`. On Linux the command line must
 * name the directory, so a PID the OS recycled for another process is not mistaken
 * for the instance (and never signalled); elsewhere only liveness is checked.
 */
export function isInstanceProcess(pid: number | undefined, dir: string): boolean {
  if (!isPidAlive(pid)) return false;
  if (os.platform() !== 'linux') return true;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes(dir);
  } catch {
    return false;
  }
}

/** Instance numbers that have a state directory, ascending. */
export function listPoolInstanceNumbers(config: ConfigProvider): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(poolRootDir(config));
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((n) => n >= 1 && n <= MAX_POOL_INSTANCE && fs.existsSync(stateFile(path.join(poolRootDir(config), String(n)))))
    .sort((a, b) => a - b);
}

/** PIDs of pool instances whose QEMU is alive. */
export function livePoolPids(config: ConfigProvider): Map<number, number> {
  const live = new Map<number, number>();
  for (const n of listPoolInstanceNumbers(config)) {
    const dir = poolInstanceDir(config, n);
    const pid = readPoolState(dir)?.pid;
    if (pid && isInstanceProcess(pid, dir)) live.set(n, pid);
  }
  return live;
}
