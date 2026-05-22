import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec, spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { getEmulatorDir, getHdcPath } from '../sdk/paths.js';

const PID_FILE = path.join(os.tmpdir(), 'oniro_emulator.pid');

function execPromise(cmd: string, cwd: string | undefined, logger: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd }, (error, stdout, stderr) => {
      if (stdout?.trim()) logger.info(`[emulator] ${stdout.trim()}`);
      if (stderr?.trim()) logger.warn(`[emulator] ${stderr.trim()}`);
      if (error) {
        logger.error(`[emulator] ${error.message}`);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Try to connect hdc to the emulator. Resolves true on success, false otherwise.
 */
export async function attemptHdcConnection(
  config: ConfigProvider,
  address = '127.0.0.1:55555',
  logger: Logger = noopLogger,
): Promise<boolean> {
  const hdc = getHdcPath(config);
  try {
    await execPromise(`"${hdc}" start -r`, undefined, logger);
    await execPromise(`"${hdc}" tconn ${address}`, undefined, logger);
    return await new Promise<boolean>((resolve) => {
      exec(`"${hdc}" list targets`, (_error, stdout) => {
        resolve(stdout?.includes(address) ?? false);
      });
    });
  } catch (err) {
    logger.warn(`hdc connection attempt failed: ${(err as Error).message}`);
    return false;
  }
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
  if (os.platform() !== 'win32' && fs.existsSync(PID_FILE)) {
    try {
      const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          logger.info(`Emulator already running (PID ${pid}); not starting another.`);
          if (opts.waitForHdcSeconds && opts.waitForHdcSeconds > 0) {
            await waitForHdc(config, opts.waitForHdcSeconds, opts.hdcPollIntervalMs ?? 5000, logger, opts.abortSignal);
          }
          return;
        } catch {
          // Stale PID file — fall through and launch a fresh one.
        }
      }
    } catch (err) {
      logger.warn(`Could not read PID file: ${(err as Error).message}`);
    }
  }

  const imagesPath = path.join(getEmulatorDir(config), 'images');
  if (!fs.existsSync(imagesPath)) {
    throw new OniroError(`Emulator images directory not found at ${imagesPath}. Run \`oniro-app emulator install\` first.`);
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
    await waitForHdc(config, opts.waitForHdcSeconds, opts.hdcPollIntervalMs ?? 5000, logger, opts.abortSignal, logPath);
  }
}

async function waitForHdc(
  config: ConfigProvider,
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
    if (await attemptHdcConnection(config, undefined, noopLogger)) {
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

  const killCmd = os.platform() === 'win32'
    ? 'taskkill /IM qemu-system-x86_64.exe /F'
    : 'pkill -f qemu-system-x86_64';
  try {
    await execPromise(killCmd, undefined, logger);
  } catch {
    // pkill / taskkill return non-zero when nothing matched — that's fine.
  }

  fs.rm(PID_FILE, { force: true }, (err) => {
    if (err) logger.warn(`Could not remove PID file: ${err.message}`);
  });
}
