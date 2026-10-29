import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { hdcExec } from '../hdc/exec.js';
import {
  ensureInstallOk,
  existingHapOrUnsigned,
  findRunningProcess,
  isBundleInstalled,
  uninstallApp,
  type InstallCandidate,
} from '../hdc/app.js';
import { reboot } from '../hdc/lifecycle.js';
import { discoverHaps, pickHap } from '../build/discoverHaps.js';
import { diffHapAssets } from './diffHapAssets.js';

export type InstallMethod = 'replace' | 'uninstall-install' | 'refuse';

/**
 * P0-5a decision: how to install given whether `hdc install -r` reported a
 * sign-info-inconsistent error (9568332). System bundles are NOT silently
 * uninstalled (that can brick the device) unless explicitly allowed.
 */
export function decideInstallMethod(s: {
  signInfoInconsistent: boolean;
  isSystemBundle: boolean;
  allowUninstall: boolean;
}): InstallMethod {
  if (!s.signInfoInconsistent) return 'replace';
  if (s.isSystemBundle && !s.allowUninstall) return 'refuse';
  return 'uninstall-install';
}

export interface RebootDecision {
  reboot: boolean;
  reason: 'asset-cache' | 'pid-unchanged' | 'none';
}

/**
 * P0-5b/c decision: whether to reboot after installing. Reboot when the HAP's
 * asset paths changed (ACE extractor cache is path-keyed and survives a process
 * kill), or when a persistent/system bundle's process didn't restart.
 */
export function decideReboot(s: {
  assetsChanged: boolean;
  isSystemBundle: boolean;
  preInstallPid: number | null;
  postInstallPid: number | null;
}): RebootDecision {
  if (s.assetsChanged) return { reboot: true, reason: 'asset-cache' };
  if (s.isSystemBundle && s.preInstallPid !== null && s.postInstallPid === s.preInstallPid) {
    return { reboot: true, reason: 'pid-unchanged' };
  }
  return { reboot: false, reason: 'none' };
}

const SIGN_INFO_INCONSISTENT = /9568332|sign.*info.*inconsistent/i;

export interface ApplyChangesOptions {
  config: ConfigProvider;
  bundle: string;
  /** Explicit HAP path. If omitted, resolved from projectDir (+ module) via discoverHaps. */
  hapPath?: string;
  projectDir?: string;
  module?: string;
  /** Local path to the currently-installed HAP; enables the asset-cache diff/reboot. */
  installedHapPath?: string;
  /** Persistent/system bundle (e.g. systemui). Default false. */
  isSystemBundle?: boolean;
  /** Permit uninstalling a system bundle on sign-info mismatch (dangerous). Default false. */
  allowUninstall?: boolean;
  deviceSerial?: string;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

export interface ApplyChangesResult {
  method: 'replace' | 'uninstall-install' | 'reboot';
  preInstallPid: number | null;
  postInstallPid: number | null;
  replaced: boolean;
  /** True when an asset-path change forced the reboot. */
  cacheCleared: boolean;
}

async function pidOf(config: ConfigProvider, bundle: string, deviceSerial?: string): Promise<number | null> {
  const proc = await findRunningProcess({ config, bundle, deviceSerial });
  return proc ? Number(proc.pid) : null;
}

async function resolveHap(opts: ApplyChangesOptions, logger: Logger): Promise<InstallCandidate> {
  let hap: InstallCandidate | undefined;
  if (opts.hapPath) {
    const hapPath =
      !path.isAbsolute(opts.hapPath) && opts.projectDir ? path.join(opts.projectDir, opts.hapPath) : opts.hapPath;
    hap = existingHapOrUnsigned(hapPath);
    if (!hap) throw new OniroError(`HAP not found at ${hapPath}.`);
  } else {
    if (!opts.projectDir) throw new OniroError('applyChanges requires hapPath or projectDir.');
    const picked = pickHap(await discoverHaps({ projectDir: opts.projectDir }), opts.module);
    if (!picked) throw new OniroError(`No HAP found${opts.module ? ` for module ${opts.module}` : ''}. Build first.`);
    hap = { path: picked.path, fallback: !picked.signed };
  }
  if (hap.fallback) logger.warn(`No signed HAP found; installing the unsigned ${path.basename(hap.path)}.`);
  return hap;
}

/**
 * Install a HAP and verify the running process took the change. Handles the
 * three failure modes the naive "install the most recent signed HAP" deploy
 * ignores: sign-info-inconsistent on `-r`, asset-cache invalidation, and a
 * persistent bundle that didn't restart. See {@link decideInstallMethod} /
 * {@link decideReboot} for the (pure, tested) branch logic.
 */
export async function applyChanges(opts: ApplyChangesOptions): Promise<ApplyChangesResult> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'apply');
  const { config, bundle, deviceSerial } = opts;
  const isSystemBundle = opts.isSystemBundle ?? false;
  const allowUninstall = opts.allowUninstall ?? false;

  const hap = await resolveHap(opts, logger);
  const hapPath = hap.path;
  logger.info(`installing ${hapPath}`);

  // Asset-path diff (best-effort; only when the caller supplies the installed HAP).
  let assetsChanged = false;
  if (opts.installedHapPath && fs.existsSync(opts.installedHapPath)) {
    try {
      const diff = await diffHapAssets({ installedHap: opts.installedHapPath, newHap: hapPath });
      assetsChanged = diff.addedAssetPaths.length > 0 || diff.removedAssetPaths.length > 0;
    } catch (err) {
      logger.debug(`asset diff skipped: ${(err as Error).message}`);
    }
  }

  const preInstallPid = await pidOf(config, bundle, deviceSerial);

  // Attempt a replace install, then decide based on the sign-info signal.
  const replaceRes = await hdcExec({ config, args: ['install', '-r', hapPath], deviceSerial, timeoutMs: 300_000 });
  const signInfoInconsistent = SIGN_INFO_INCONSISTENT.test(`${replaceRes.stdout}${replaceRes.stderr}`);
  const decision = decideInstallMethod({ signInfoInconsistent, isSystemBundle, allowUninstall });

  let installMethod: 'replace' | 'uninstall-install';
  if (decision === 'refuse') {
    throw new OniroError(
      `Refusing to reinstall system bundle ${bundle}: signing certs are inconsistent (9568332). ` +
        'Align the signing certs first — uninstalling a system bundle can brick the device. ' +
        'Pass allowUninstall to override.',
    );
  }
  if (decision === 'uninstall-install') {
    logger.warn(`sign-info inconsistent for ${bundle}; uninstalling then installing fresh.`);
    await uninstallApp({ config, bundle, deviceSerial });
    ensureInstallOk(
      await hdcExec({ config, args: ['install', hapPath], deviceSerial, timeoutMs: 300_000 }),
      `hdc install ${hapPath}`,
      hap,
    );
    installMethod = 'uninstall-install';
  } else {
    ensureInstallOk(replaceRes, `hdc install -r ${hapPath}`, hap);
    installMethod = 'replace';
  }

  // hdc's own exit code says nothing about the bundle manager's verdict, so
  // confirm the bundle is there before reporting success.
  if (!(await isBundleInstalled({ config, bundle, deviceSerial }))) {
    throw new OniroError(
      `hdc reported ${path.basename(hapPath)} as installed, but bm dump does not list ${bundle}. ` +
        'Check that the HAP was built from this project (its bundleName must match).',
    );
  }

  let postInstallPid = await pidOf(config, bundle, deviceSerial);
  const rebootDecision = decideReboot({ assetsChanged, isSystemBundle, preInstallPid, postInstallPid });

  let method: ApplyChangesResult['method'] = installMethod;
  let cacheCleared = false;
  if (rebootDecision.reboot) {
    logger.info(`rebooting (${rebootDecision.reason}) to apply changes to ${bundle}.`);
    await reboot({ config, waitForBundle: bundle, deviceSerial, abortSignal: opts.abortSignal, logger: opts.logger });
    postInstallPid = await pidOf(config, bundle, deviceSerial);
    method = 'reboot';
    cacheCleared = rebootDecision.reason === 'asset-cache';
  }

  return { method, preInstallPid, postInstallPid, replaced: installMethod === 'replace', cacheCleared };
}
