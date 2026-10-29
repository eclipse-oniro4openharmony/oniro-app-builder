import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { CommandFailedError, OniroError } from '../ports/errors.js';
import { getHdcPath } from '../sdk/paths.js';
import { discoverHaps, pickHap } from '../build/discoverHaps.js';
import { killProcessTree, spawnCompat } from './spawnCompat.js';
import { hdcExec, hdcTargetArgs, shell, ensureOk, type HdcExecResult } from './exec.js';
import { getBundleName, getMainAbility } from './project.js';

export interface InstallAppOptions {
  config: ConfigProvider;
  projectDir: string;
  /**
   * Explicit path (absolute, or relative to projectDir) to the `.hap`. Falls back
   * to the `hapPath` config key, then to the well-known signed entry HAP, then to
   * the HAPs the build produced (signed first, else unsigned).
   */
  hapPath?: string;
  deviceSerial?: string;
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

/**
 * The bundle manager's rejection in `hdc install` output, or null when the
 * install went through. hdc exits 0 either way: success prints `msg:install
 * bundle successfully.`, a rejection `msg:error: failed to install bundle.`
 * with a `code:95xxxxx`. Pure/testable.
 */
export function detectInstallFailure(output: string): string | null {
  return /\[Fail\]|msg:\s*error|error:\s*failed to install|code:\s*95\d{5}/i.test(output) ? output.trim() : null;
}

/** Throw a typed {@link CommandFailedError} when hdc or the bundle manager rejected an install. */
export function ensureInstallOk(result: HdcExecResult, command: string): HdcExecResult {
  ensureOk(result, command);
  const failure = detectInstallFailure(`${result.stdout}\n${result.stderr}`);
  if (failure) throw new CommandFailedError(command, 1, failure);
  return result;
}

async function resolveInstallHap(opts: InstallAppOptions, logger: Logger): Promise<string> {
  const configured = opts.hapPath ?? opts.config.get('hapPath', '');
  const relative = configured || defaultPaths.hapPath;
  const hapPath = path.isAbsolute(relative) ? relative : path.join(opts.projectDir, relative);
  if (fs.existsSync(hapPath) || configured) {
    if (!fs.existsSync(hapPath)) throw new OniroError(`HAP file not found at: ${hapPath}. Build the app first.`);
    return hapPath;
  }
  // No explicit HAP and no signed entry HAP: take what the build produced.
  const picked = pickHap(await discoverHaps({ projectDir: opts.projectDir }));
  if (!picked) throw new OniroError(`No HAP found under ${opts.projectDir}. Build the app first (\`oniro-app build\`).`);
  if (!picked.signed) {
    logger.warn(`Installing the unsigned ${path.basename(picked.path)}: only the HarmonyOS emulator accepts unsigned HAPs.`);
  }
  return picked.path;
}

export async function installApp(opts: InstallAppOptions): Promise<InstallAppResult> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  const hapPath = await resolveInstallHap(opts, logger);

  const result = await hdcExec({
    config: opts.config,
    args: ['install', hapPath],
    deviceSerial: opts.deviceSerial,
    timeoutMs: 300_000,
  });
  if (result.stdout.trim()) logger.info(result.stdout.trim());
  if (result.stderr.trim()) logger.warn(result.stderr.trim());
  ensureInstallOk(result, `hdc install ${hapPath}`);

  let bundleName = '';
  try {
    bundleName = getBundleName(opts.projectDir);
  } catch {
    // bundleName is informational; a HAP from a project without AppScope still installs.
  }
  return { installed: true, bundleName, hapPath, output: `${result.stdout}${result.stderr}`.trim() };
}

/**
 * Whether `bm dump -n <bundle>` finds the bundle on the device. A missing bundle
 * prints `error: failed to get information…`; an installed one, `<bundle>:` and
 * its JSON.
 */
export async function isBundleInstalled(opts: BundleOptions): Promise<boolean> {
  const safe = opts.bundle.replace(/'/g, `'\\''`);
  const res = await shell({
    config: opts.config,
    command: `bm dump -n '${safe}'`,
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 15_000,
    logger: opts.logger,
  });
  ensureOk(res, `hdc shell bm dump -n ${opts.bundle}`);
  return res.stdout.includes('{') && !/failed to get information/i.test(res.stdout);
}

export interface LaunchAppOptions {
  config: ConfigProvider;
  /** Project mode: resolve bundle + main ability from the project. Required unless `bundleName` is given. */
  projectDir?: string;
  /**
   * Bundle mode: launch an already-installed app directly by bundle name (no
   * project needed). When set, `projectDir` is ignored. If `abilityName` is
   * omitted, the main ability is resolved from the device via `bm dump -n`.
   */
  bundleName?: string;
  /** Override the module name if it isn't the default `entry` (project mode). */
  moduleName?: string;
  /** Explicit ability to launch; defaults to the module's mainElement / first visible ability (project mode) or the installed bundle's main ability (bundle mode). */
  abilityName?: string;
  deviceSerial?: string;
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

/**
 * Parse the main ability of an installed bundle from `bm dump -n <bundle>`
 * output. Pure/testable. The output is a bundle-name prefix line followed by a
 * JSON blob; we take the entry module's `mainElementName` (fallback
 * `mainAbility`), or the first module that declares one. Returns null when the
 * bundle isn't installed or the output is unparseable.
 */
export function parseMainAbilityFromBmDump(stdout: string): string | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  let info: { hapModuleInfos?: Array<{ mainElementName?: string; mainAbility?: string; moduleType?: number | string }> };
  try {
    info = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  const mods = Array.isArray(info?.hapModuleInfos) ? info.hapModuleInfos : [];
  const abilityOf = (m: { mainElementName?: string; mainAbility?: string }): string | undefined =>
    (m?.mainElementName || m?.mainAbility) || undefined;
  const isEntry = (m: { moduleType?: number | string }): boolean =>
    m?.moduleType === 1 || m?.moduleType === '1' || m?.moduleType === 'entry';
  const entry = mods.find((m) => isEntry(m) && abilityOf(m));
  const any = mods.find((m) => abilityOf(m));
  return (entry && abilityOf(entry)) || (any && abilityOf(any)) || null;
}

/** Resolve an installed bundle's main ability off the device via `bm dump -n`. */
async function resolveInstalledMainAbility(opts: {
  config: ConfigProvider;
  bundle: string;
  deviceSerial?: string;
  logger?: Logger;
}): Promise<string> {
  const res = await shell({
    config: opts.config,
    command: `bm dump -n ${opts.bundle}`,
    deviceSerial: opts.deviceSerial,
    timeoutMs: 15_000,
    logger: opts.logger,
  });
  const ability = parseMainAbilityFromBmDump(res.stdout);
  if (!ability) {
    throw new OniroError(
      `Could not determine the main ability for installed bundle ${opts.bundle} ` +
        `(is it installed?). Pass an explicit ability instead.`,
    );
  }
  return ability;
}

export async function launchApp(opts: LaunchAppOptions): Promise<void> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  let bundleName: string;
  let mainAbility: string;
  if (opts.bundleName) {
    // Bundle mode: launch an already-installed app directly (no project).
    bundleName = opts.bundleName;
    mainAbility =
      opts.abilityName ??
      (await resolveInstalledMainAbility({
        config: opts.config,
        bundle: bundleName,
        deviceSerial: opts.deviceSerial,
        logger: opts.logger,
      }));
  } else {
    if (!opts.projectDir) throw new OniroError('launchApp requires either bundleName or projectDir.');
    bundleName = getBundleName(opts.projectDir);
    mainAbility = getMainAbility(opts.projectDir, opts.moduleName, opts.abilityName);
  }
  // Pass ability/bundle as discrete argv elements (shell:false), never interpolated
  // into a host shell string — this is the injection fix vs the old `aa start -a ${x}`.
  const result = await hdcExec({
    config: opts.config,
    args: ['shell', 'aa', 'start', '-a', mainAbility, '-b', bundleName],
    deviceSerial: opts.deviceSerial,
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
  options: { targetProcessName?: string; timeoutMs?: number; deviceSerial?: string; logger?: Logger } = {},
): Promise<RunningProcess[] | string> {
  const logger = options.logger ?? noopLogger;
  const timeoutMs = options.timeoutMs ?? 1000;
  const hdc = getHdcPath(config);

  return new Promise((resolve, reject) => {
    // `hdc` may be a batch wrapper on Windows (an `hdcPath` override pointing at
    // a proxy/tunnel script), which a bare spawn cannot execute — spawnCompat
    // routes those through cmd.exe. It can also throw synchronously, so the
    // failure is funnelled into the same rejection as the 'error' event below.
    let proc: ChildProcess;
    try {
      proc = spawnCompat(hdc, [...hdcTargetArgs(options.deviceSerial), 'track-jpid']);
    } catch (err) {
      reject(new OniroError(`Failed to spawn ${hdc}: ${err instanceof Error ? err.message : String(err)}`, err));
      return;
    }
    const processes: RunningProcess[] = [];
    let resolved = false;

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const pid = match[1]!;
        const name = match[2]!;
        processes.push({ pid, name });
        if (options.targetProcessName && name === options.targetProcessName && !resolved) {
          resolved = true;
          killProcessTree(proc);
          resolve(pid);
          return;
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
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
      killProcessTree(proc);
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
    const list = await listRunningProcesses(opts.config, {
      timeoutMs: 1200,
      deviceSerial: opts.deviceSerial,
      logger: opts.logger,
    });
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
