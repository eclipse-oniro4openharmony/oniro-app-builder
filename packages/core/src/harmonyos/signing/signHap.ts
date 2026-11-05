import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../../ports/config.js';
import type { Logger } from '../../ports/logger.js';
import { noopLogger } from '../../ports/logger.js';
import { OniroError } from '../../ports/errors.js';
import { decryptPwd, encryptPwd } from '../../sign/encryptKey.js';
import { createHttpClient, type HarmonyOsHttpClient } from '../http.js';
import { requireHarmonyOsSdk } from '../sdk.js';
import type { HarmonyOsSession } from '../auth/session.js';
import { createAgcClient } from './agc.js';
import {
  assertAgcBundleName,
  issueSigningMaterial,
  materialDirFor,
  profileProblem,
  profileResultFields,
  sharedMaterialDir,
  type HarmonyOsSigningResult,
} from './autoSign.js';
import { collectLocalDevices } from './devices.js';
import { signHapFile } from './keystore.js';
import { resolveSigningMaterialPaths, type SigningMaterialPaths } from './paths.js';
import { aclPermissionsAmong } from './project.js';
import { defaultSignedHapPath, readHapSigningInfo, writeHapAtomically } from '../../sign/hapInfo.js';

/**
 * The material for signing prebuilt HAPs of one bundle. Keyed by bundle name, not
 * project path: there is no project, and a bundle's profile is the same wherever
 * its HAP lies. `pwdPath` holds the keystore password, encrypted with the shared
 * material, which a project keeps in its signingConfig instead.
 */
export function resolveHapSigningMaterialPaths(
  config: ConfigProvider,
  bundleName: string,
): SigningMaterialPaths & { pwdPath: string } {
  const paths = resolveSigningMaterialPaths(config, 'hap', bundleName);
  return { ...paths, pwdPath: paths.p12Path.replace(/\.p12$/, '.pwd') };
}

/** The stored keystore password, or null when it is missing or will not decrypt. */
function readStoredPassword(paths: SigningMaterialPaths & { pwdPath: string }): string | null {
  try {
    return decryptPwd(fs.readFileSync(paths.pwdPath, 'utf8').trim(), materialDirFor(paths));
  } catch {
    return null;
  }
}

export interface HarmonyOsSignHapOptions {
  config: ConfigProvider;
  session: HarmonyOsSession;
  /** The HAP to sign: unsigned, or signed with other material. */
  hapPath: string;
  /** Where to write the signed HAP. Default {@link defaultSignedHapPath}. May equal `hapPath`. */
  outPath?: string;
  /** AGC team. Defaults to the signed-in account's own id. */
  teamId?: string;
  /** Regenerate the material even when the existing material is still valid. */
  force?: boolean;
  http?: HarmonyOsHttpClient;
  logger?: Logger;
}

export interface HarmonyOsSignHapResult extends HarmonyOsSigningResult {
  /** The signed HAP. */
  outPath: string;
}

/**
 * Sign a prebuilt HAP, with no project, for HarmonyOS devices: the bundle name and
 * ACL permissions come from its `module.json`, AGC issues (or the previous run
 * left) a debug certificate and profile, and hap-sign-tool signs a copy.
 */
export async function harmonyOsSignHap(opts: HarmonyOsSignHapOptions): Promise<HarmonyOsSignHapResult> {
  const logger = opts.logger ?? noopLogger;
  const hapPath = path.resolve(opts.hapPath);
  const outPath = path.resolve(opts.outPath ?? defaultSignedHapPath(hapPath));

  // Everything about the HAP is checked before anything reaches AGC.
  const info = await readHapSigningInfo(hapPath);
  const { bundleName } = info;
  if (info.compileSdkType === 'OpenHarmony') {
    throw new OniroError(
      `${hapPath} was built for OpenHarmony, so a HarmonyOS device would not run it; sign it without --harmonyos.`,
    );
  }
  assertAgcBundleName(bundleName);
  const aclPermissions = aclPermissionsAmong(info.requestedPermissions);
  if (aclPermissions.length > 0) {
    logger.info(`[harmonyos] HAP requests ${aclPermissions.length} ACL permission(s): ${aclPermissions.join(', ')}`);
  }

  const sdk = requireHarmonyOsSdk({ config: opts.config, logger });
  const auth = await opts.session.resolveAgcAuth({ teamId: opts.teamId });
  const paths = resolveHapSigningMaterialPaths(opts.config, bundleName);
  const { pwdPath, ...material } = paths;
  logger.info(`[harmonyos] Signing ${path.basename(hapPath)} as ${bundleName} (team ${auth.teamId}).`);

  const local = await collectLocalDevices(opts.config, logger);
  let keyPwd = opts.force ? null : readStoredPassword(paths);
  const missing = Object.values(material).find((file) => !fs.existsSync(file));
  const reason = opts.force
    ? '--force was passed'
    : missing
      ? `${missing} is missing`
      : keyPwd === null
        ? 'the stored keystore password could not be read'
        : profileProblem({
            profilePath: material.profilePath,
            bundleName,
            teamId: auth.teamId,
            connectedUdids: local.devices.map((d) => d.udid),
            aclPermissions,
          });

  if (!reason && keyPwd !== null) {
    logger.info('[harmonyos] Reusing the existing signing material, which is still valid.');
  } else {
    logger.info(`[harmonyos] Regenerating signing material: ${reason}.`);
    fs.rmSync(pwdPath, { force: true });
    keyPwd = await issueSigningMaterial({
      agc: createAgcClient(opts.http ?? createHttpClient({ logger }), auth),
      local,
      sdk,
      paths: material,
      bundleName,
      aclPermissions,
      teamId: auth.teamId,
      logger,
    });
    fs.writeFileSync(pwdPath, encryptPwd(keyPwd, sharedMaterialDir(material)), { mode: 0o600 });
  }

  const password = keyPwd;
  await writeHapAtomically(outPath, (tmpPath) =>
    signHapFile({ sdk, inFile: hapPath, outFile: tmpPath, ...material, keyPwd: password, logger }),
  );

  const profile = profileResultFields(material.profilePath);
  logger.info(`[harmonyos] Wrote ${outPath}.`);
  return { bundleName, teamId: auth.teamId, paths: material, regenerated: !!reason, ...profile, outPath };
}
