import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { getHdcPath } from '../sdk/paths.js';
import { hdcExec, ensureOk } from './exec.js';
import { getBundleName, getMainAbility } from './project.js';

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
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  const relativeHapPath = opts.hapPath ?? opts.config.get('hapPath', defaultPaths.hapPath);
  const hapPath = path.isAbsolute(relativeHapPath) ? relativeHapPath : path.join(opts.projectDir, relativeHapPath);

  if (!fs.existsSync(hapPath)) {
    throw new OniroError(`HAP file not found at: ${hapPath}. Build and sign the app first.`);
  }

  const result = await hdcExec({ config: opts.config, args: ['install', hapPath], timeoutMs: 300_000 });
  if (result.stdout.trim()) logger.info(result.stdout.trim());
  if (result.stderr.trim()) logger.warn(result.stderr.trim());
  ensureOk(result, `hdc install ${hapPath}`);
}

export interface LaunchAppOptions {
  config: ConfigProvider;
  projectDir: string;
  /** Override the module name if it isn't the default `entry`. */
  moduleName?: string;
  logger?: Logger;
}

export async function launchApp(opts: LaunchAppOptions): Promise<void> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  const bundleName = getBundleName(opts.projectDir);
  const mainAbility = getMainAbility(opts.projectDir, opts.moduleName);
  // Pass ability/bundle as discrete argv elements (shell:false), never interpolated
  // into a host shell string — this is the injection fix vs the old `aa start -a ${x}`.
  const result = await hdcExec({
    config: opts.config,
    args: ['shell', 'aa', 'start', '-a', mainAbility, '-b', bundleName],
  });
  if (result.stdout.trim()) logger.info(result.stdout.trim());
  if (result.stderr.trim()) logger.warn(result.stderr.trim());
  ensureOk(result, `hdc shell aa start -a ${mainAbility} -b ${bundleName}`);
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
