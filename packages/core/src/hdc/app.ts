import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { getHdcPath } from '../sdk/paths.js';
import { hdcExec, shell, ensureOk } from './exec.js';
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

export interface InstallAppResult {
  installed: boolean;
  /** Bundle name read from the project's AppScope/app.json5, or '' if unavailable. */
  bundleName: string;
  /** The resolved absolute HAP path that was installed. */
  hapPath: string;
  /** Combined stdout+stderr from the install, trimmed. */
  output: string;
}

export async function installApp(opts: InstallAppOptions): Promise<InstallAppResult> {
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

  let bundleName = '';
  try {
    bundleName = getBundleName(opts.projectDir);
  } catch {
    // bundleName is informational; a HAP from a project without AppScope still installs.
  }
  return { installed: true, bundleName, hapPath, output: `${result.stdout}${result.stderr}`.trim() };
}

export interface LaunchAppOptions {
  config: ConfigProvider;
  projectDir: string;
  /** Override the module name if it isn't the default `entry`. */
  moduleName?: string;
  /** Explicit ability to launch; defaults to the module's mainElement / first visible ability. */
  abilityName?: string;
  logger?: Logger;
}

/**
 * `aa start` exits 0 even when the launch is refused — a locked screen
 * (`Error Code:10106102`), a missing ability, a permission denial, etc. The failure
 * only shows up in its output. Returns the offending text when the output indicates a
 * failed launch, or null when it looks like a success.
 */
export function detectAaStartFailure(output: string): string | null {
  return /failed to start ability|Error Code:\s*\d|Error Message:/i.test(output) ? output.trim() : null;
}

export async function launchApp(opts: LaunchAppOptions): Promise<void> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  const bundleName = getBundleName(opts.projectDir);
  const mainAbility = getMainAbility(opts.projectDir, opts.moduleName, opts.abilityName);
  // Pass ability/bundle as discrete argv elements (shell:false), never interpolated
  // into a host shell string — this is the injection fix vs the old `aa start -a ${x}`.
  const result = await hdcExec({
    config: opts.config,
    args: ['shell', 'aa', 'start', '-a', mainAbility, '-b', bundleName],
  });
  if (result.stdout.trim()) logger.info(result.stdout.trim());
  if (result.stderr.trim()) logger.warn(result.stderr.trim());
  ensureOk(result, `hdc shell aa start -a ${mainAbility} -b ${bundleName}`);
  // `aa start` reports launch failures in its output, not its exit code — surface them
  // instead of silently reporting success.
  const failure = detectAaStartFailure(`${result.stdout}\n${result.stderr}`);
  if (failure) {
    throw new OniroError(`Failed to launch ${bundleName} (${mainAbility}): ${failure}`);
  }
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

export interface BundleOptions {
  config: ConfigProvider;
  bundle: string;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Non-throwing companion to {@link listRunningProcesses}: resolve a running
 * process for a bundle, or `null` when it isn't running. Suitable for "is X
 * running?" checks (e.g. the pre/post-install pid comparison in applyChanges).
 *
 * `pidof` matches the bundle's main (UIAbility) process. When that isn't found,
 * we fall back to `track-jpid` to also catch **extension-ability** processes,
 * which run under a separate process name `"<bundle>:<ext>"` (e.g. a
 * ServiceExtension, FormExtension, UIExtension or input method). Without this,
 * "verify the running process took the change" silently reported nothing for an
 * app whose only live process is an extension.
 */
export async function findRunningProcess(opts: BundleOptions): Promise<RunningProcess | null> {
  const safe = opts.bundle.replace(/'/g, `'\\''`);
  const res = await shell({
    config: opts.config,
    command: `pidof '${safe}'`,
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 10_000,
    logger: opts.logger,
  });
  const pid = res.stdout.trim().split(/\s+/).filter(Boolean)[0];
  if (res.code === 0 && pid && /^\d+$/.test(pid)) return { pid, name: opts.bundle };

  // Fallback: the bundle may only be alive as an extension process. track-jpid
  // names them "<bundle>/<bundle>:<ext>" (vs bare "<bundle>" for the main).
  try {
    const list = await listRunningProcesses(opts.config, { timeoutMs: 1200, logger: opts.logger });
    if (Array.isArray(list)) {
      const mine = (name: string): boolean =>
        name === opts.bundle || name.startsWith(`${opts.bundle}/`) || name.startsWith(`${opts.bundle}:`);
      const match = list.find((p) => p.name === opts.bundle) ?? list.find((p) => mine(p.name));
      if (match) return match;
    }
  } catch {
    // best-effort; fall through to "not running"
  }
  return null;
}

/** Uninstall an app by bundle name (`hdc uninstall <bundle>`). */
export async function uninstallApp(opts: BundleOptions): Promise<void> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  const res = await hdcExec({
    config: opts.config,
    args: ['uninstall', opts.bundle],
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  if (res.stdout.trim()) logger.info(res.stdout.trim());
  if (res.stderr.trim()) logger.warn(res.stderr.trim());
  ensureOk(res, `hdc uninstall ${opts.bundle}`);
}

/** Force-stop an app (`hdc shell aa force-stop <bundle>`). */
export async function forceStop(opts: BundleOptions): Promise<void> {
  const res = await shell({
    config: opts.config,
    command: `aa force-stop ${opts.bundle}`,
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 30_000,
    logger: opts.logger,
  });
  ensureOk(res, `hdc shell aa force-stop ${opts.bundle}`);
}
