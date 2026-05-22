import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
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

interface RunCommand {
  cmd: string;
  cwd: string;
  usePid: boolean;
}

function getRunCommand(imagesPath: string): RunCommand {
  const runSh = path.join(imagesPath, 'run.sh');
  const runBat = path.join(imagesPath, 'run.bat');
  if (os.platform() === 'win32') {
    if (fs.existsSync(runBat)) {
      return { cmd: `cmd /c start "" /B "${runBat}"`, cwd: imagesPath, usePid: false };
    }
    if (fs.existsSync(runSh)) {
      return { cmd: runSh, cwd: imagesPath, usePid: false };
    }
    throw new OniroError('Emulator run script not found (run.bat or run.sh).');
  }
  if (fs.existsSync(runSh)) return { cmd: './run.sh', cwd: imagesPath, usePid: true };
  if (fs.existsSync(runBat)) return { cmd: './run.bat', cwd: imagesPath, usePid: true };
  throw new OniroError('Emulator run script not found (run.sh or run.bat).');
}

export interface StartEmulatorOptions {
  config: ConfigProvider;
  logger?: Logger;
  /** Wait for hdc to connect after starting the emulator. Default true. */
  waitForHdc?: boolean;
  /** When waitForHdc is true, how often (ms) to retry the hdc connection. Default 3000. */
  hdcPollIntervalMs?: number;
  abortSignal?: AbortSignal;
}

export async function startEmulator(opts: StartEmulatorOptions): Promise<void> {
  const { config } = opts;
  const logger = opts.logger ?? noopLogger;

  const qemuCheckCmd = os.platform() === 'win32' ? 'where qemu-system-x86_64' : 'which qemu-system-x86_64';
  const qemuAvailable = await new Promise<boolean>((resolve) => {
    exec(qemuCheckCmd, (error, stdout) => resolve(!error && Boolean(stdout.trim())));
  });
  if (!qemuAvailable) {
    throw new OniroError('qemu-system-x86_64 not found in PATH.');
  }

  // Avoid double-start if the PID file points at a live process (POSIX only).
  if (os.platform() !== 'win32' && fs.existsSync(PID_FILE)) {
    try {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (pid && !Number.isNaN(Number(pid))) {
        try {
          process.kill(Number(pid), 0);
          logger.info(`Emulator already running with PID ${pid}.`);
          return;
        } catch {
          // Stale PID file — fall through and start.
        }
      }
    } catch (err) {
      logger.warn(`Could not read PID file: ${(err as Error).message}`);
    }
  }

  const imagesPath = path.join(getEmulatorDir(config), 'images');
  const runInfo = getRunCommand(imagesPath);
  if (runInfo.usePid) {
    await execPromise(`(${runInfo.cmd} > /dev/null 2>&1 & echo $! > ${PID_FILE})`, runInfo.cwd, logger);
    logger.info(`Emulator started in background. PID stored in ${PID_FILE}`);
  } else {
    await execPromise(runInfo.cmd, runInfo.cwd, logger);
    logger.info('Emulator started.');
  }

  if (opts.waitForHdc === false) return;
  const interval = opts.hdcPollIntervalMs ?? 3000;
  while (true) {
    if (opts.abortSignal?.aborted) return;
    if (await attemptHdcConnection(config, undefined, logger)) {
      logger.info('hdc connected.');
      return;
    }
    logger.info('Waiting for hdc connection...');
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function stopEmulator(logger: Logger = noopLogger): Promise<void> {
  const killCmd = os.platform() === 'win32'
    ? 'taskkill /IM qemu-system-x86_64.exe /F'
    : 'pkill -f qemu-system-x86_64';
  await execPromise(killCmd, undefined, logger);
  fs.rm(PID_FILE, { force: true }, (err) => {
    if (err) logger.warn(`Could not remove PID file: ${err.message}`);
  });
}
