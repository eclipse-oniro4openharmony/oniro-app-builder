/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/commands/signature.ts`, `src/signature/generate-certificate.ts`,
 * `src/signature/re-generate-sign.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import type { ConfigProvider } from '../../ports/config.js';
import type { Logger } from '../../ports/logger.js';
import { noopLogger } from '../../ports/logger.js';
import { OniroError } from '../../ports/errors.js';
import { createMaterial, encryptPwd, getKey } from '../../sign/encryptKey.js';
import { getBundleName } from '../../hdc/project.js';
import { isValidBundleName } from '../../project/validators.js';
import { createHttpClient, type HarmonyOsHttpClient } from '../http.js';
import { requireHarmonyOsSdk } from '../sdk.js';
import type { HarmonyOsSession } from '../auth/session.js';
import { createAgcClient } from './agc.js';
import { registerDevices } from './devices.js';
import { AgcError, SIGNING_ERRORS } from './errors.js';
import { KEY_ALIAS, SIGN_ALG, generateKeystoreAndCsr } from './keystore.js';
import { resolveSigningMaterialPaths, type SigningMaterialPaths } from './paths.js';
import { readProvisionProfile, verifySigningMaterial } from './profile.js';
import { collectAclPermissions } from './project.js';

interface BuildProfile {
  app?: {
    signingConfigs?: Array<{ name?: string; type?: string; material?: Record<string, string> }>;
    products?: Array<{ name?: string; signingConfig?: string; bundleName?: string }>;
  };
}

/**
 * Why the existing material cannot be reused, or null when it can. Reuse matters:
 * every regeneration spends a slot of the team's small certificate quota.
 *
 * @internal exposed for tests.
 */
export function shouldRegenerate(input: {
  paths: SigningMaterialPaths;
  buildProfile: BuildProfile;
  productName: string;
  bundleName: string;
  teamId: string;
  connectedUdids: string[];
  aclPermissions: string[];
  force?: boolean;
  now?: Date;
}): string | null {
  if (input.force) return '--force was passed';
  const missing = Object.values(input.paths).find((file) => !fs.existsSync(file));
  if (missing) return `${missing} is missing`;

  // The keystore password only exists, encrypted, in the project's signingConfig; a
  // fresh checkout reusing the material from ~/.ohos/config cannot recover it.
  const config = input.buildProfile.app?.signingConfigs?.find((c) => c.name === input.productName);
  if (config?.type !== 'HarmonyOS' || config.material?.profile !== input.paths.profilePath) {
    return 'build-profile.json5 has no signingConfig for this material';
  }

  const profile = readProvisionProfile(input.paths.profilePath);
  if (!profile) return 'the provisioning profile could not be read';
  if (profile.bundleName !== input.bundleName) return `the profile is for bundle '${profile.bundleName}'`;
  if (profile.developerId && profile.developerId !== input.teamId) {
    return `the profile was issued to team '${profile.developerId}'`;
  }
  if (profile.notAfter && profile.notAfter <= (input.now ?? new Date())) return 'the profile has expired';
  const unnamed = input.connectedUdids.filter((udid) => !profile.deviceIds.includes(udid.toUpperCase()));
  if (unnamed.length > 0) return `${unnamed.length} connected device(s) are not named in the profile`;
  const acls = input.aclPermissions.filter((p) => !profile.aclPermissions.includes(p));
  if (acls.length > 0) return `the profile lacks ACL permission(s) ${acls.join(', ')}`;
  return null;
}

/**
 * Point `productName` at a HarmonyOS signingConfig for `paths`, replacing any config
 * of that name and leaving every other one alone. The keystore and key share one
 * password, so one ciphertext serves both.
 *
 * @internal exposed for tests.
 */
export function writeSigningConfig(opts: {
  buildProfilePath: string;
  buildProfile: BuildProfile;
  productName: string;
  paths: SigningMaterialPaths;
  encryptedPassword: string;
}): void {
  const app = (opts.buildProfile.app ??= {});
  const entry = {
    name: opts.productName,
    // `type` is what makes hvigor treat this as HarmonyOS signing material.
    type: 'HarmonyOS',
    material: {
      certpath: opts.paths.cerPath,
      keyAlias: KEY_ALIAS,
      keyPassword: opts.encryptedPassword,
      profile: opts.paths.profilePath,
      signAlg: SIGN_ALG,
      storeFile: opts.paths.p12Path,
      storePassword: opts.encryptedPassword,
    },
  };
  app.signingConfigs = [...(app.signingConfigs ?? []).filter((c) => c.name !== opts.productName), entry];
  for (const product of app.products ?? []) {
    if (product.name === opts.productName) product.signingConfig = opts.productName;
  }
  // Strict JSON, like the OpenHarmony signing path: still valid JSON5.
  fs.writeFileSync(opts.buildProfilePath, JSON.stringify(opts.buildProfile, null, 2));
}

export interface HarmonyOsAutoSignOptions {
  config: ConfigProvider;
  session: HarmonyOsSession;
  projectDir: string;
  /** Default `default`. */
  productName?: string;
  /** AGC team. Defaults to the signed-in account's own id. */
  teamId?: string;
  /** Regenerate even when the existing material is still valid. */
  force?: boolean;
  http?: HarmonyOsHttpClient;
  logger?: Logger;
}

export interface HarmonyOsSigningResult {
  bundleName: string;
  teamId: string;
  paths: SigningMaterialPaths;
  /** False when still-valid material was reused without asking AGC for anything. */
  regenerated: boolean;
  /** UDIDs the profile is valid for. */
  deviceIds: string[];
}

/**
 * Sign a HarmonyOS project with the signed-in Huawei developer account, the way
 * DevEco Studio's automatic signing does: generate a keystore and CSR, have AGC
 * issue a debug certificate, register connected devices, issue a debug profile
 * naming the team's devices, and write the encrypted signingConfig.
 */
export async function harmonyOsAutoSign(opts: HarmonyOsAutoSignOptions): Promise<HarmonyOsSigningResult> {
  const logger = opts.logger ?? noopLogger;
  const productName = opts.productName ?? 'default';
  const projectDir = path.resolve(opts.projectDir);
  const buildProfilePath = path.join(projectDir, 'build-profile.json5');

  let buildProfile: BuildProfile;
  try {
    buildProfile = JSON5.parse(fs.readFileSync(buildProfilePath, 'utf-8')) as BuildProfile;
  } catch (err) {
    throw new OniroError(`Could not read ${buildProfilePath}: ${(err as Error).message}`, err);
  }
  const product = buildProfile.app?.products?.find((p) => p.name === productName);
  if (!product) throw new OniroError(`${buildProfilePath} declares no product named '${productName}'.`);
  // A product may override the app's bundle name. Validated before anything reaches
  // AGC, so a bad name costs no certificate.
  const bundleName = product.bundleName || getBundleName(projectDir);
  if (!isValidBundleName(bundleName) || bundleName.split('.').length < 3 || bundleName.length < 7 || bundleName.length > 128) {
    throw new AgcError(SIGNING_ERRORS.BUNDLE_NAME_INVALID);
  }

  const sdk = requireHarmonyOsSdk({ config: opts.config, logger });
  const auth = await opts.session.resolveAgcAuth({ teamId: opts.teamId });
  const agc = createAgcClient(opts.http ?? createHttpClient({ logger }), auth);
  const aclPermissions = collectAclPermissions(projectDir, logger);
  const paths = resolveSigningMaterialPaths(opts.config, productName, projectDir);
  logger.info(`[harmonyos] Signing ${bundleName} (product '${productName}', team ${auth.teamId}).`);

  const { deviceIds, connectedUdids } = await registerDevices(agc, opts.config, logger);
  const result = (regenerated: boolean): HarmonyOsSigningResult => ({
    bundleName,
    teamId: auth.teamId,
    paths,
    regenerated,
    deviceIds: readProvisionProfile(paths.profilePath)?.deviceIds ?? [],
  });

  const reason = shouldRegenerate({
    paths,
    buildProfile,
    productName,
    bundleName,
    teamId: auth.teamId,
    connectedUdids,
    aclPermissions,
    force: opts.force,
  });
  if (!reason) {
    logger.info('[harmonyos] Reusing the existing signing material, which is still valid.');
    return result(false);
  }
  logger.info(`[harmonyos] Regenerating signing material: ${reason}.`);
  for (const file of Object.values(paths)) fs.rmSync(file, { force: true });

  // AGC will not issue a second certificate under one name, so ours is replaced.
  // The name is oniro-app's own: upstream uses DevEco Studio's `auto_debug_`, and
  // replacing that certificate would revoke the material Studio signs with.
  const certName = `oniro_debug_${auth.teamId.replace(/[\\/.:]/g, '')}.cer`;
  const stale = (await agc.listCertificates()).find((c) => c.certName === certName);
  if (stale) {
    logger.info(`[harmonyos] Replacing the previous '${certName}' certificate in AppGallery Connect...`);
    await agc.deleteCertificate(stale.id);
  }

  const { keyPwd, csr } = await generateKeystoreAndCsr({ sdk, p12Path: paths.p12Path, csrPath: paths.csrPath, logger });
  logger.info('[harmonyos] Requesting a debug certificate from AppGallery Connect...');
  await agc.addCertificate(certName, csr);
  const cert = (await agc.listCertificates()).find((c) => c.certName === certName);
  if (!cert) throw new AgcError(SIGNING_ERRORS.CERT_REQUEST);
  await agc.download('cert', cert.certObjectId, paths.cerPath);

  logger.info('[harmonyos] Issuing the debug provisioning profile...');
  const profile = await agc.addDebugProfile({
    provisionName: `oniro_${crypto.randomBytes(6).toString('hex')}`,
    bundleName,
    certId: cert.id,
    deviceIds,
    aclPermissions,
  });
  try {
    await agc.download('profile', profile.provisionFileUrl, paths.profilePath);
  } finally {
    // The file is what the build needs; the AGC record would only use up the team's quota.
    await agc.deleteProfile(profile.id).catch((err: Error) => {
      logger.debug(`[harmonyos] Could not delete profile ${profile.id} from AppGallery Connect: ${err.message}`);
    });
  }
  try {
    verifySigningMaterial({ ...paths, keyAlias: KEY_ALIAS, keyPwd });
  } catch (err) {
    fs.rmSync(paths.profilePath, { force: true });
    throw err;
  }

  // The OpenHarmony signing path's encryption, with its material next to the keystores.
  // Shared by every project there, so existing material is kept.
  const materialDir = path.join(path.dirname(paths.p12Path), 'material');
  try {
    getKey(materialDir);
  } catch {
    createMaterial(materialDir);
  }
  writeSigningConfig({ buildProfilePath, buildProfile, productName, paths, encryptedPassword: encryptPwd(keyPwd, materialDir) });
  logger.info(`[harmonyos] Wrote signingConfigs['${productName}'] to ${buildProfilePath}.`);
  return result(true);
}
