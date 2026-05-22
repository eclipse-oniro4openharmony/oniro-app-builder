import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec, spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { getHdcPath } from '../sdk/paths.js';
import { getBundleName, getMainAbility } from './project.js';

function execPromise(cmd: string, logger: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (stdout?.trim()) logger.info(`[hdc] ${stdout.trim()}`);
      if (stderr?.trim()) logger.warn(`[hdc] ${stderr.trim()}`);
      if (error) {
        logger.error(`[hdc] ${error.message}`);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export interface InstallAppOptions {
  config: ConfigProvider;
  projectDir: string;
  /**
   * Explicit path (absolute, or relative to projectDir) to the signed `.hap`.
   * Falls back to the `hapPath` config key, then to the well-known default.
   */
  hapPath?: string;
  logger?: Logger;
}

export async function installApp(opts: InstallAppOptions): Promise<void> {
  const logger = opts.logger ?? noopLogger;
  const relativeHapPath = opts.hapPath ?? opts.config.get('hapPath', defaultPaths.hapPath);
  const hapPath = path.isAbsolute(relativeHapPath) ? relativeHapPath : path.join(opts.projectDir, relativeHapPath);

  if (!fs.existsSync(hapPath)) {
    throw new OniroError(`HAP file not found at: ${hapPath}. Build and sign the app first.`);
  }

  const hdc = getHdcPath(opts.config);
  await execPromise(`"${hdc}" install "${hapPath}"`, logger);
}

export interface LaunchAppOptions {
  config: ConfigProvider;
  projectDir: string;
  /** Override the module name if it isn't the default `entry`. */
  moduleName?: string;
  logger?: Logger;
}

export async function launchApp(opts: LaunchAppOptions): Promise<void> {
  const logger = opts.logger ?? noopLogger;
  const bundleName = getBundleName(opts.projectDir);
  const mainAbility = getMainAbility(opts.projectDir, opts.moduleName);
  const hdc = getHdcPath(opts.config);
  await execPromise(`"${hdc}" shell aa start -a ${mainAbility} -b ${bundleName}`, logger);
}

export interface RunningProcess {
  pid: string;
  name: string;
}

/**
 * List running processes via `hdc track-jpid`. Times out after `timeoutMs`.
 * When `targetProcessName` is set, resolves to that process's PID early; otherwise
 * resolves to the full list collected within the timeout window.
 */
export function listRunningProcesses(
  config: ConfigProvider,
  options: { targetProcessName?: string; timeoutMs?: number; logger?: Logger } = {},
): Promise<RunningProcess[] | string> {
  const logger = options.logger ?? noopLogger;
  const timeoutMs = options.timeoutMs ?? 1000;
  const hdc = getHdcPath(config);

  return new Promise((resolve, reject) => {
    const proc = spawn(hdc, ['track-jpid']);
    const processes: RunningProcess[] = [];
    let resolved = false;

    proc.stdout.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const pid = match[1]!;
        const name = match[2]!;
        processes.push({ pid, name });
        if (options.targetProcessName && name === options.targetProcessName && !resolved) {
          resolved = true;
          proc.kill();
          resolve(pid);
          return;
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      logger.warn(`[hdc track-jpid] ${data.toString()}`);
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      if (options.targetProcessName) {
        reject(new OniroError(`Could not find process for bundle: ${options.targetProcessName}`));
      } else {
        resolve(processes);
      }
    }, timeoutMs);

    proc.on('close', () => {
      clearTimeout(timeout);
      if (resolved) return;
      resolved = true;
      if (options.targetProcessName) {
        reject(new OniroError(`Could not find process for bundle: ${options.targetProcessName}`));
      } else {
        resolve(processes);
      }
    });
  });
}

export async function findAppProcessId(config: ConfigProvider, projectDir: string, logger?: Logger): Promise<string> {
  const bundleName = getBundleName(projectDir);
  const result = await listRunningProcesses(config, { targetProcessName: bundleName, logger });
  return result as string;
}
