import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { hdcExec, ensureOk } from '../hdc/exec.js';
import { findRunningProcess, uninstallApp } from '../hdc/app.js';
import { reboot } from '../hdc/lifecycle.js';
import { discoverHaps } from '../build/discoverHaps.js';
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

async function resolveHapPath(opts: ApplyChangesOptions): Promise<string> {
  let hapPath = opts.hapPath;
  if (hapPath) {
    if (!path.isAbsolute(hapPath) && opts.projectDir) hapPath = path.join(opts.projectDir, hapPath);
  } else {
    if (!opts.projectDir) throw new OniroError('applyChanges requires hapPath or projectDir.');
    const haps = await discoverHaps({ projectDir: opts.projectDir });
    if (opts.module) {
      const signed = haps[opts.module]?.signed ?? [];
      if (signed.length === 0) throw new OniroError(`No signed HAP for module ${opts.module}. Build first.`);
      hapPath = signed[0]!;
    } else {
      const withSigned = Object.entries(haps).filter(([, m]) => m.signed.length > 0);
      if (withSigned.length === 0) throw new OniroError('No signed HAP found. Build first.');
      if (withSigned.length > 1) {
        throw new OniroError(
          `Multiple modules have signed HAPs (${withSigned.map(([k]) => k).join(', ')}). Pass module to choose.`,
        );
      }
      hapPath = withSigned[0]![1].signed[0]!;
    }
  }
  if (!fs.existsSync(hapPath)) throw new OniroError(`HAP not found at ${hapPath}.`);
  return hapPath;
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

  const hapPath = await resolveHapPath(opts);

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
    ensureOk(await hdcExec({ config, args: ['install', hapPath], deviceSerial, timeoutMs: 300_000 }), `hdc install ${hapPath}`);
    installMethod = 'uninstall-install';
  } else {
    ensureOk(replaceRes, `hdc install -r ${hapPath}`);
    installMethod = 'replace';
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
