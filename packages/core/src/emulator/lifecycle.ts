import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { getEmulatorDir } from '../sdk/paths.js';
import { hdcExec, runProcess } from '../hdc/exec.js';
import { isEmulatorInstalled } from './install.js';
import { DEFAULT_EMULATOR_PID_FILE as PID_FILE, livePoolPids } from './state.js';
import { getDefaultInstanceStatus, listPoolInstanceStatuses, probeEmulatorBoot, type EmulatorInstanceStatus } from './pool.js';

/**
 * Try to connect hdc to the emulator. Resolves true on success, false otherwise.
 */
export async function attemptHdcConnection(
  config: ConfigProvider,
  address = '127.0.0.1:55555',
  logger: Logger = noopLogger,
): Promise<boolean> {
  try {
    await hdcExec({ config, args: ['start', '-r'], logger });
    await hdcExec({ config, args: ['tconn', address], logger });
    const targets = await hdcExec({ config, args: ['list', 'targets'], logger });
    return targets.stdout.includes(address);
  } catch (err) {
    logger.warn(`hdc connection attempt failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * The address hdc dials for the default emulator started with `connect` (the
 * launcher's port-forward bind address, `--connect`). A wildcard bind host
 * (`0.0.0.0`) is reached on the loopback. Pure/testable.
 */
export function emulatorHdcAddress(connect: string | undefined): string {
  if (!connect) return '127.0.0.1:55555';
  const m = /^(.*):(\d+)$/.exec(connect);
  if (!m) return connect;
  const host = m[1] === '0.0.0.0' || m[1] === '' ? '127.0.0.1' : m[1];
  return `${host}:${m[2]}`;
}

interface LauncherSpec {
  /** Executable to spawn (e.g. `bash` on POSIX, `cmd.exe` on Windows). */
  command: string;
  /** Args, including the launcher script path. */
  args: readonly string[];
  /** Working directory (images dir). */
  cwd: string;
}

/**
 * Pick the right bundled launcher for the current OS. Prefers run.bat on Windows
 * and run.sh elsewhere; falls back to the other if only one is present.
 */
function resolveLauncher(
  imagesPath: string,
  headless: boolean,
  connect: string | undefined,
): LauncherSpec {
  const runSh = path.join(imagesPath, 'run.sh');
  const runBat = path.join(imagesPath, 'run.bat');
  const extra: string[] = [];
  if (headless) extra.push('--headless');
  if (connect) extra.push('--connect', connect);

  if (os.platform() === 'win32') {
    if (fs.existsSync(runBat)) {
      return { command: 'cmd.exe', args: ['/c', runBat, ...extra], cwd: imagesPath };
    }
    if (fs.existsSync(runSh)) {
      return { command: 'bash', args: [runSh, ...extra], cwd: imagesPath };
    }
    throw new OniroError(`No emulator launcher (run.bat or run.sh) found in ${imagesPath}.`);
  }

  if (fs.existsSync(runSh)) {
    return { command: 'bash', args: [runSh, ...extra], cwd: imagesPath };
  }
  if (fs.existsSync(runBat)) {
    return { command: 'bash', args: [runBat, ...extra], cwd: imagesPath };
  }
  throw new OniroError(`No emulator launcher (run.sh or run.bat) found in ${imagesPath}.`);
}

export interface StartEmulatorOptions {
  config: ConfigProvider;
  logger?: Logger;
  /** Pass --headless to the bundled launcher (VNC + telnet serial, no local window). */
  headless?: boolean;
  /**
   * Override the launcher's host:port for hdc port forwarding. Defaults to the
   * launcher's own default (typically `127.0.0.1:55555`). Use `0.0.0.0:55555`
   * on hosts where QEMU refuses to bind the hostfwd to 127.0.0.1 (e.g. some
   * CI runners with restricted loopback bindings).
   */
  connect?: string;
  /**
   * Redirect launcher stdout/stderr to this file. Default: discard
   * (/dev/null on POSIX, NUL on Windows). Use a real path in CI so you can
   * surface qemu output on failure.
   */
  logFile?: string;
  /**
   * If > 0, block until hdc connects to the running emulator, up to this many
   * seconds. 0 (default) returns as soon as the launcher process is spawned.
   */
  waitForHdcSeconds?: number;
  /** Poll interval for the hdc wait, ms. Default 5000. */
  hdcPollIntervalMs?: number;
  /**
   * If > 0, block until the guest reports `bootevent.boot.completed=true` over hdc, up
   * to this many seconds. Connects with `hdc tconn` only: unlike `waitForHdcSeconds`,
   * it never restarts the hdc server, so other connected devices are not disturbed.
   */
  waitReadySeconds?: number;
  abortSignal?: AbortSignal;
}

/**
 * Launch the Oniro emulator in the background via the bundled run.sh/run.bat.
 *
 * The launcher process is detached + unref'd so callers can exit while the
 * emulator keeps running. A PID file is written to the OS temp dir so
 * `stopEmulator` and rerun-detection logic can find the process later.
 */
export async function startEmulator(opts: StartEmulatorOptions): Promise<void> {
  const { config } = opts;
  const logger = opts.logger ?? noopLogger;

  // Detect a still-running emulator from a previous run (POSIX only — Windows
  // PID semantics with process groups make this unreliable to check by hand).
  let runningPid: number | undefined;
  if (os.platform() !== 'win32' && fs.existsSync(PID_FILE)) {
    try {
      const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          runningPid = pid;
        } catch {
          // Stale PID file — fall through and launch a fresh one.
        }
      }
    } catch (err) {
      logger.warn(`Could not read PID file: ${(err as Error).message}`);
    }
  }
  if (runningPid !== undefined) {
    // Outside the PID probe on purpose: a wait timeout or cancellation on a running
    // emulator must reach the caller, not be read as a stale PID file (which would
    // launch a second emulator on the same read-write images).
    logger.info(`Emulator already running (PID ${runningPid}); not starting another.`);
    if (opts.waitForHdcSeconds && opts.waitForHdcSeconds > 0) {
      await waitForHdc(config, emulatorHdcAddress(opts.connect), opts.waitForHdcSeconds, opts.hdcPollIntervalMs ?? 5000, logger, opts.abortSignal);
    }
    if (opts.waitReadySeconds && opts.waitReadySeconds > 0) {
      await waitForBootCompleted(config, opts, logger);
    }
    return;
  }

  const imagesPath = path.join(getEmulatorDir(config), 'images');
  if (!fs.existsSync(imagesPath)) {
    throw new OniroError(`Emulator images directory not found at ${imagesPath}. Run \`oniro-app emulator install\` first.`);
  }
  // Pool instances (`startPoolInstance`) keep the base images open as read-only
  // backing files; run.sh opens them read-write, which QEMU refuses and which would
  // corrupt the instances' overlays.
  const pool = livePoolPids(config);
  if (pool.size > 0) {
    const ns = [...pool.keys()];
    throw new OniroError(
      `Emulator pool instance(s) ${ns.join(', ')} are running on the same base images, which the default emulator ` +
        `opens read-write. Stop them first: ${ns.map((n) => `oniro-app emulator stop --instance ${n}`).join('; ')}.`,
    );
  }
  const launcher = resolveLauncher(imagesPath, opts.headless === true, opts.connect);

  // Open the log target. Default to OS-level null sink so the child process
  // doesn't keep the parent's stdout/stderr file descriptors alive.
  const logPath = opts.logFile ?? (os.platform() === 'win32' ? 'NUL' : '/dev/null');
  const logFd = fs.openSync(logPath, 'a');

  let child;
  try {
    child = spawn(launcher.command, [...launcher.args], {
      cwd: launcher.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(logFd);
  }

  // Catch synchronous spawn failures (e.g. bash not found on PATH).
  if (!child.pid) {
    throw new OniroError(`Failed to spawn launcher (${launcher.command} ${launcher.args.join(' ')}).`);
  }

  // Record PID + detach. The launcher script `exec`s into qemu so this PID
  // remains valid for the whole emulator lifetime.
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  logger.info(`Emulator launched (PID ${child.pid}). Logs: ${logPath}`);

  // Watch for an immediate failure (e.g. KVM unavailable → run.sh exits ~instantly
  // with a friendly error). We hold a reference to the exit event but won't await
  // it if the child stays alive.
  const earlyExit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });
  const liveness = new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 2000));
  const outcome = await Promise.race([earlyExit, liveness]);
  if (outcome !== 'alive') {
    const tail = readTail(logPath, 4000);
    throw new OniroError(
      `Emulator launcher exited with code ${outcome} before reaching steady state. Tail of ${logPath}:\n${tail}`,
    );
  }

  if (opts.waitForHdcSeconds && opts.waitForHdcSeconds > 0) {
    await waitForHdc(config, emulatorHdcAddress(opts.connect), opts.waitForHdcSeconds, opts.hdcPollIntervalMs ?? 5000, logger, opts.abortSignal, logPath);
  }
  if (opts.waitReadySeconds && opts.waitReadySeconds > 0) {
    await waitForBootCompleted(config, opts, logger, logPath);
  }
}

/** Poll the default emulator's guest until `bootevent.boot.completed` is true (tconn only). */
async function waitForBootCompleted(
  config: ConfigProvider,
  opts: StartEmulatorOptions,
  logger: Logger,
  logPathForDiagnostics?: string,
): Promise<void> {
  const address = emulatorHdcAddress(opts.connect);
  const timeoutSeconds = opts.waitReadySeconds!;
  const deadline = Date.now() + timeoutSeconds * 1000;
  const started = Date.now();
  for (;;) {
    if (opts.abortSignal?.aborted) throw new CancelledError('Wait for the emulator cancelled.');
    const probe = await probeEmulatorBoot(config, address, { logger: noopLogger });
    if (probe.bootCompleted) {
      logger.info(`Emulator ready at ${address} after ${Math.round((Date.now() - started) / 1000)}s.`);
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(opts.hdcPollIntervalMs ?? 5000, Math.max(0, deadline - Date.now()))));
  }
  const tail = logPathForDiagnostics ? readTail(logPathForDiagnostics, 4000) : '';
  throw new OniroError(`Emulator at ${address} did not finish booting within ${timeoutSeconds}s.${tail ? `\nTail of emulator log:\n${tail}` : ''}`);
}

async function waitForHdc(
  config: ConfigProvider,
  address: string,
  timeoutSeconds: number,
  pollIntervalMs: number,
  logger: Logger,
  abortSignal?: AbortSignal,
  logPathForDiagnostics?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (abortSignal?.aborted) throw new CancelledError('hdc wait cancelled.');
    attempt++;
    if (await attemptHdcConnection(config, address, noopLogger)) {
      logger.info(`hdc connected on attempt ${attempt}.`);
      return;
    }
    // Every ~6 attempts, log a heartbeat with the latest emulator log tail so
    // a hung guest is debuggable from a single command's output stream.
    if (attempt % 6 === 0) {
      logger.info(`hdc not yet ready (attempt ${attempt}, ${Math.max(0, deadline - Date.now()) / 1000 | 0}s remaining).`);
      if (logPathForDiagnostics) {
        const tail = readTail(logPathForDiagnostics, 1200);
        if (tail.trim()) logger.debug(`emulator log tail:\n${tail}`);
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  const tail = logPathForDiagnostics ? readTail(logPathForDiagnostics, 4000) : '';
  throw new OniroError(`hdc did not connect within ${timeoutSeconds}s.${tail ? `\nTail of emulator log:\n${tail}` : ''}`);
}

function readTail(filePath: string, bytes: number): string {
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

export async function stopEmulator(logger: Logger = noopLogger): Promise<void> {
  // Prefer killing the recorded PID; fall back to a broad kill for stragglers.
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
          logger.info(`Sent SIGTERM to emulator PID ${pid}.`);
        } catch (err) {
          logger.warn(`Could not signal PID ${pid}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.warn(`Could not read PID file: ${(err as Error).message}`);
    }
  }

  // pkill / taskkill exit non-zero when nothing matched — runProcess resolves on any
  // exit code, so we simply ignore that. The try/catch only guards a missing binary.
  const killCmds = os.platform() === 'win32'
    ? QEMU_BINARIES.map((b) => ['taskkill', '/IM', `${b}.exe`, '/F'])
    : [['pkill', '-f', QEMU_PROCESS_PATTERN]];
  for (const [killCmd, ...killArgs] of killCmds) {
    try {
      await runProcess({ command: killCmd!, args: killArgs, logger });
    } catch (err) {
      logger.warn(`[emulator] could not run ${killCmd}: ${(err as Error).message}`);
    }
  }

  fs.rm(PID_FILE, { force: true }, (err) => {
    if (err) logger.warn(`Could not remove PID file: ${err.message}`);
  });
}

export interface EmulatorStatus {
  installed: boolean;
  /** The configured emulator directory. */
  dir: string;
  /** Whether the default emulator's QEMU is alive (pool instances do not count). */
  running: boolean;
  /** The hdc address checked for `connected`. */
  address: string;
  /** hdc lists `address` as a Connected target. */
  connected: boolean;
  /**
   * Every instance: the default emulator (instance 0, `address`) first, then each pool
   * instance that has a state directory, with its health code.
   */
  instances: EmulatorInstanceStatus[];
}

/** The QEMU binaries that run an emulator: the x86_64 and the arm64 one. */
export const QEMU_BINARIES = ['qemu-system-x86_64', 'qemu-system-aarch64'] as const;
/** pgrep/pkill -f pattern (extended regex) matching either binary. */
export const QEMU_PROCESS_PATTERN = 'qemu-system-(x86_64|aarch64)';

/**
 * Whether an emulator QEMU process is alive: the PID file from `startEmulator`
 * (POSIX only, as there), else a process-table scan.
 */
async function isQemuRunning(config: ConfigProvider, logger: Logger): Promise<boolean> {
  if (os.platform() !== 'win32') {
    try {
      const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, 0);
        return true;
      }
    } catch {
      // No PID file, or the process is gone: scan the process table.
    }
  }
  const [cmd, ...args] = os.platform() === 'win32'
    ? ['tasklist', '/FI', 'IMAGENAME eq qemu-system-*', '/NH']
    : ['pgrep', '-f', QEMU_PROCESS_PATTERN];
  // Pool instances are QEMU processes too; they are not the default emulator.
  const poolPids = new Set(livePoolPids(config).values());
  try {
    const res = await runProcess({ command: cmd!, args, timeoutMs: 10_000, logger });
    const pids = os.platform() === 'win32'
      ? res.stdout.split(/\r?\n/).filter((l) => /qemu-system-(x86_64|aarch64)/i.test(l)).map((l) => Number(l.trim().split(/\s+/)[1]))
      : res.code === 0 ? res.stdout.split(/\s+/).filter(Boolean).map(Number) : [];
    return pids.some((pid) => !poolPids.has(pid));
  } catch {
    return false;
  }
}

/**
 * Report on the Oniro emulator without starting it: installed, running, and whether
 * hdc sees it at `address` (default `127.0.0.1:55555`). Other emulators, such as
 * DevEco Studio's HarmonyOS emulator, are not covered: they appear in `listDevices`.
 */
export async function getEmulatorStatus(
  config: ConfigProvider,
  opts: { address?: string; logger?: Logger } = {},
): Promise<EmulatorStatus> {
  const logger = opts.logger ?? noopLogger;
  const address = opts.address ?? '127.0.0.1:55555';
  const dir = getEmulatorDir(config);
  const running = await isQemuRunning(config, logger);
  // Probing a live instance `hdc tconn`s it (never restarting the hdc server), so
  // hdc's target list is read afterwards.
  const [instance0, pool] = await Promise.all([
    getDefaultInstanceStatus(config, { running, address, logger }),
    listPoolInstanceStatuses(config, { logger }),
  ]);
  let connected = false;
  try {
    const targets = await hdcExec({ config, args: ['list', 'targets', '-v'], timeoutMs: 10_000, logger });
    connected = targets.stdout.split('\n').some((l) => l.trim().startsWith(address) && /\bConnected\b/.test(l));
  } catch {
    // No hdc: not connected.
  }
  return {
    installed: isEmulatorInstalled(config),
    dir,
    running,
    address,
    connected,
    instances: [instance0, ...pool],
  };
}
