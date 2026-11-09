import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSON5 from 'json5';
import { encryptPwd, createMaterial } from './encryptKey.js';
import { OPEN_HARMONY_APPLICATION_CERT } from './applicationCert.js';
import { detectProjectSdkVersion } from '../sdk/detectProjectSdk.js';
import { ALL_SDKS } from '../sdk/constants.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError, SdkNotInstalledError } from '../ports/errors.js';
import { formatUtc, readProvisionProfile } from '../harmonyos/signing/profile.js';
import { leafCertificateOf } from './certChain.js';

/** Ability Privilege Level written into the profile's `bundle-info.apl`. */
export type Apl = 'normal' | 'system_basic' | 'system_core';

/** App feature written into the profile's `bundle-info.app-feature`. */
export type AppFeature = 'hos_normal_app' | 'hos_system_app';

export const APL_VALUES: readonly Apl[] = ['normal', 'system_basic', 'system_core'];
export const APP_FEATURE_VALUES: readonly AppFeature[] = ['hos_normal_app', 'hos_system_app'];

/** Keystore passwords. These must match the keystore in use. */
export interface SigningPasswords {
  store: string;
  key: string;
}

export const DEFAULT_PASSWORDS: SigningPasswords = { store: '123456', key: '123456' };

/**
 * Which signing key pairs with the chosen `apl`.
 *
 * - `'profile-release'` — the **OpenHarmony Application Profile Release** key.
 *   Default for apl=normal. Matches the cert chain that ships with the SDK
 *   (`OpenHarmonyProfileRelease.pem`). What `hvigor` uses for ordinary apps.
 *
 * - `'application-release'` — the **OpenHarmony Application Release** key.
 *   Required for apl=system_basic|system_core. BMS's parse-profile-prop check
 *   rejects HAPs whose `distribution-certificate` subject is "Application
 *   Profile Release" when the HAP requests permissions above its apl. The
 *   matching cert chain (`OpenHarmonyApplication.cer`) is not shipped in the
 *   SDK, so we ship it ourselves under `applicationCert.ts`.
 */
export type SigningKind = 'profile-release' | 'application-release';

/** @internal exposed for tests. */
export function pickSigningKind(apl: Apl): SigningKind {
  return apl === 'normal' ? 'profile-release' : 'application-release';
}

interface SigningKindConfig {
  /** keystore alias used by hvigor's SignHap task. */
  hapKeyAlias: string;
  /** filename of the cert chain inside `signatures/` referenced by build-profile.json5 `certpath`. */
  certBasename: string;
}

export const SIGNING_KIND_CONFIG: Record<SigningKind, SigningKindConfig> = {
  'profile-release': {
    hapKeyAlias: 'openharmony application profile release',
    certBasename: 'OpenHarmonyProfileRelease.pem',
  },
  'application-release': {
    hapKeyAlias: 'OpenHarmony Application Release',
    certBasename: 'OpenHarmonyApplication.cer',
  },
};

export interface GenerateSigningConfigsOptions {
  /** Absolute path to the OpenHarmony project (the folder containing build-profile.json5). */
  projectDir: string;
  /** Absolute path to the OS-specific SDK home (the folder containing API-version subfolders). */
  sdkHome: string;
  /**
   * APL level to write into the profile's `bundle-info.apl`. Defaults to `'normal'`.
   * Apps requesting permissions above `normal` (e.g. `ohos.permission.GET_WIFI_INFO_INTERNAL`)
   * need `system_basic` or `system_core` — otherwise `bm install` fails with
   * `grant request permissions failed`.
   */
  apl?: Apl;
  /**
   * App feature to write into `bundle-info.app-feature`. Defaults to `'hos_normal_app'`
   * when `apl='normal'`, otherwise `'hos_system_app'`.
   */
  appFeature?: AppFeature;
  /**
   * Permission names to write into the profile's `acls.allowed-acls`. Required for
   * apps that request permissions above their `apl` (e.g. a system_basic app
   * requesting `ohos.permission.CAPTURE_SCREEN`). When omitted, the template's
   * existing `allowed-acls` is left alone.
   */
  acls?: string[];
  /**
   * Privileges to write into the profile's `app-privilege-capabilities`, e.g.
   * `AllowAppUsePrivilegeExtension` for an app that declares a privileged extension
   * ability (else install fails with 9568344 "not allow use privilege extension"),
   * `AllowAppMultiProcess` or `AllowAppDesktopIconHide`. When omitted, the
   * template's value is left alone.
   */
  appPrivilegeCapabilities?: string[];
  /**
   * Keystore passwords written into the profile sign step and the build-profile
   * signingConfigs. Defaults to `'123456'` (the SDK's bundled OpenHarmony.p12
   * password). Only override when supplying a matching custom keystore.
   */
  passwords?: SigningPasswords;
  /**
   * Override the bundled application cert chain (application-release kind only).
   * When set, this file is copied to `signatures/OpenHarmonyApplication.cer`
   * instead of the inlined cert. May also be sourced from `config.applicationCertPath`.
   */
  applicationCertPath?: string;
  /**
   * hvigor product whose `compileSdkVersion` picks the SDK the signing files come
   * from. Defaults to the first product, which in a project that also targets
   * HarmonyOS may be a HarmonyOS product with no numeric API level.
   */
  product?: string;
  /** Optional logger; defaults to no-op. */
  logger?: Logger;
}

/** The SDK files signing uses, from `<sdkHome>/<api>/toolchains/lib`. */
export interface SdkSigningFiles {
  signTool: string;
  keystore: string;
  profileCert: string;
  unsignedProfileTemplate: string;
}

/** @internal exposed for tests. */
export function sdkSigningFiles(sdkPath: string): SdkSigningFiles {
  return {
    signTool: path.join(sdkPath, 'toolchains/lib/hap-sign-tool.jar'),
    keystore: path.join(sdkPath, 'toolchains/lib/OpenHarmony.p12'),
    profileCert: path.join(sdkPath, 'toolchains/lib/OpenHarmonyProfileRelease.pem'),
    unsignedProfileTemplate: path.join(sdkPath, 'toolchains/lib/UnsgnedReleasedProfileTemplate.json'),
  };
}

/** Copy the SDK's keystore, certificates and profile template into `signaturesDir`. */
export function copySigningFiles(
  signaturesDir: string,
  paths: Omit<SdkSigningFiles, 'signTool'>,
  kind: SigningKind,
  logger: Logger,
  applicationCertPath?: string,
): void {
  logger.info(`[sign] Copying signing material into ${signaturesDir}...`);
  fs.mkdirSync(signaturesDir, { recursive: true });

  fs.copyFileSync(paths.keystore, path.join(signaturesDir, 'OpenHarmony.p12'));
  fs.copyFileSync(paths.profileCert, path.join(signaturesDir, 'OpenHarmonyProfileRelease.pem'));
  fs.copyFileSync(paths.unsignedProfileTemplate, path.join(signaturesDir, 'UnsgnedReleasedProfileTemplate.json'));

  if (kind === 'application-release') {
    const dest = path.join(signaturesDir, 'OpenHarmonyApplication.cer');
    if (applicationCertPath) {
      fs.copyFileSync(applicationCertPath, dest);
    } else {
      fs.writeFileSync(dest, OPEN_HARMONY_APPLICATION_CERT);
    }
  }
}

/**
 * Pick the app-feature value: explicit override wins; otherwise `hos_normal_app` for
 * apl=normal, `hos_system_app` for system_basic/system_core.
 * @internal exposed for tests.
 */
export function resolveAppFeature(apl: Apl, override?: AppFeature): AppFeature {
  if (override) return override;
  return apl === 'normal' ? 'hos_normal_app' : 'hos_system_app';
}

/**
 * Read the third certificate (the leaf) from a 3-cert PEM chain. The chain is
 * stored root → intermediate → leaf, so the distribution-certificate we want
 * is the third block.
 */
function extractLeafCertificate(chainPath: string): string {
  const certContent = fs.readFileSync(chainPath, 'utf-8');
  const parts = certContent.split('-----END CERTIFICATE-----');
  if (parts.length < 3) {
    throw new OniroError(`${chainPath} does not contain enough certificates.`);
  }
  return parts[2]!.trim() + '\n-----END CERTIFICATE-----\n';
}

/** @internal exposed for tests. */
export function modifyProfileTemplate(
  projectDir: string,
  apl: Apl,
  appFeature: AppFeature,
  logger: Logger,
  options: { kind?: SigningKind; acls?: string[]; appPrivilegeCapabilities?: string[] } = {},
): void {
  const appJsonPath = path.join(projectDir, 'AppScope/app.json5');
  if (!fs.existsSync(appJsonPath)) {
    throw new OniroError(`${appJsonPath} does not exist.`);
  }

  let appJson: { app?: { bundleName?: string } };
  try {
    appJson = JSON5.parse(fs.readFileSync(appJsonPath, 'utf-8'));
  } catch (e) {
    throw new OniroError(`Error parsing ${appJsonPath}: ${(e as Error).message}`, e);
  }
  if (!appJson.app?.bundleName) {
    throw new OniroError('app.json5 does not contain app.bundleName.');
  }
  applyProfileTemplate(path.join(projectDir, 'signatures'), appJson.app.bundleName, apl, appFeature, logger, options);
}

/**
 * Fill `signaturesDir/UnsgnedReleasedProfileTemplate.json` in for `bundleName`:
 * apl, app-feature, the distribution certificate of the signing `kind`, and the
 * ACLs and privileges when given.
 *
 * @internal exposed for tests.
 */
export function applyProfileTemplate(
  signaturesDir: string,
  bundleName: string,
  apl: Apl,
  appFeature: AppFeature,
  logger: Logger,
  options: { kind?: SigningKind; acls?: string[]; appPrivilegeCapabilities?: string[] } = {},
): void {
  const kind = options.kind ?? pickSigningKind(apl);
  logger.info(`[sign] Modifying profile template (apl=${apl}, app-feature=${appFeature}, kind=${kind})...`);
  const profileTemplatePath = path.join(signaturesDir, 'UnsgnedReleasedProfileTemplate.json');

  let profileTemplate: {
    'bundle-info'?: {
      'bundle-name'?: string;
      'distribution-certificate'?: string;
      apl?: string;
      'app-feature'?: string;
    };
    acls?: { 'allowed-acls'?: string[] };
    'app-privilege-capabilities'?: string[];
  };
  try {
    profileTemplate = JSON.parse(fs.readFileSync(profileTemplatePath, 'utf-8'));
  } catch (e) {
    throw new OniroError(`Error parsing ${profileTemplatePath}: ${(e as Error).message}`, e);
  }

  if (!profileTemplate['bundle-info']) {
    throw new OniroError('UnsgnedReleasedProfileTemplate.json is missing the bundle-info section.');
  }

  profileTemplate['bundle-info']['bundle-name'] = bundleName;
  profileTemplate['bundle-info']['apl'] = apl;
  profileTemplate['bundle-info']['app-feature'] = appFeature;

  const distCertChainPath = path.join(signaturesDir, SIGNING_KIND_CONFIG[kind].certBasename);
  profileTemplate['bundle-info']['distribution-certificate'] = extractLeafCertificate(distCertChainPath);

  if (options.acls !== undefined) {
    profileTemplate.acls = profileTemplate.acls ?? {};
    profileTemplate.acls['allowed-acls'] = options.acls;
  }
  if (options.appPrivilegeCapabilities !== undefined) {
    profileTemplate['app-privilege-capabilities'] = options.appPrivilegeCapabilities;
  }

  fs.writeFileSync(profileTemplatePath, JSON.stringify(profileTemplate, null, 2));
}

/** Sign the filled-in profile template in `signaturesDir` into `app1-profile.p7b`. */
export function generateP7bFile(
  signaturesDir: string,
  paths: Pick<SdkSigningFiles, 'signTool' | 'profileCert' | 'keystore'>,
  logger: Logger,
  passwords: SigningPasswords,
): void {
  logger.info('[sign] Generating P7b profile via hap-sign-tool...');
  const profileTemplatePath = path.join(signaturesDir, 'UnsgnedReleasedProfileTemplate.json');
  const outputProfilePath = path.join(signaturesDir, 'app1-profile.p7b');

  // The profile itself is always signed by the Profile Release key, regardless
  // of the HAP signing kind. The profile's `distribution-certificate` field
  // (set by modifyProfileTemplate) is what tells BMS which cert will sign the HAP.
  const args = [
    '-jar', paths.signTool,
    'sign-profile',
    '-keyAlias', 'openharmony application profile release',
    '-signAlg', 'SHA256withECDSA',
    '-mode', 'localSign',
    '-profileCertFile', paths.profileCert,
    '-inFile', profileTemplatePath,
    '-keystoreFile', paths.keystore,
    '-outFile', outputProfilePath,
    '-keyPwd', passwords.key,
    '-keystorePwd', passwords.store,
  ];

  try {
    execFileSync('java', args, { stdio: 'inherit' });
  } catch (e) {
    throw new OniroError(
      `hap-sign-tool failed. Ensure a JDK (with keytool/java) is on PATH. Underlying error: ${(e as Error).message}`,
      e,
    );
  }
}

/**
 * Read all `products[*].signingConfig` names from the project's build-profile.json5.
 * Returns the unique names in declaration order. Falls back to `['default']` when
 * the file is missing or has no products.
 * @internal exposed for tests.
 */
export function detectSigningConfigNames(projectDir: string): string[] {
  const buildProfilePath = path.join(projectDir, 'build-profile.json5');
  if (!fs.existsSync(buildProfilePath)) return ['default'];

  let parsed: { app?: { products?: Array<{ signingConfig?: unknown }> } };
  try {
    parsed = JSON5.parse(fs.readFileSync(buildProfilePath, 'utf-8'));
  } catch {
    return ['default'];
  }

  const products = parsed.app?.products;
  if (!Array.isArray(products) || products.length === 0) return ['default'];

  const names: string[] = [];
  for (const product of products) {
    const name = product.signingConfig;
    if (typeof name === 'string' && name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }
  return names.length > 0 ? names : ['default'];
}

/** @internal exposed for tests. Needs `signatures/material` (see {@link createMaterial}). */
export function updateBuildProfile(projectDir: string, kind: SigningKind, logger: Logger, passwords: SigningPasswords): void {
  logger.info('[sign] Writing signing configs into build-profile.json5...');
  const materialDir = path.join(projectDir, 'signatures', 'material');
  const buildProfilePath = path.join(projectDir, 'build-profile.json5');

  const encryptedStorePassword = encryptPwd(passwords.store, materialDir);
  const encryptedKeyPassword = encryptPwd(passwords.key, materialDir);

  let buildProfile: { app?: { signingConfigs?: unknown[]; products?: Array<{ signingConfig?: unknown }> } } = { app: {} };
  if (fs.existsSync(buildProfilePath)) {
    try {
      buildProfile = JSON5.parse(fs.readFileSync(buildProfilePath, 'utf-8'));
    } catch (e) {
      throw new OniroError(`Error parsing ${buildProfilePath}: ${(e as Error).message}`, e);
    }
  }

  const { hapKeyAlias, certBasename } = SIGNING_KIND_CONFIG[kind];
  const configNames = detectSigningConfigNames(projectDir);
  logger.info(`[sign] Writing signingConfigs entries: ${configNames.join(', ')}`);

  buildProfile.app = buildProfile.app ?? {};
  buildProfile.app.signingConfigs = configNames.map((name) => ({
    name,
    material: {
      certpath: `./signatures/${certBasename}`,
      storePassword: encryptedStorePassword,
      keyAlias: hapKeyAlias,
      keyPassword: encryptedKeyPassword,
      profile: './signatures/app1-profile.p7b',
      signAlg: 'SHA256withECDSA',
      storeFile: './signatures/OpenHarmony.p12',
    },
  }));
  // A product that names no signingConfig builds unsigned HAPs even with one defined.
  for (const product of buildProfile.app.products ?? []) {
    if (typeof product.signingConfig !== 'string' || product.signingConfig === '') {
      product.signingConfig = configNames[0];
      logger.info(`[sign] Pointing a product with no signingConfig at "${configNames[0]}".`);
    }
  }

  // Intentionally strict JSON (not JSON5) — keeps the file readable by VS Code's JSON parser.
  fs.writeFileSync(buildProfilePath, JSON.stringify(buildProfile, null, 2));
}

function prepareMaterialDirectory(projectDir: string, logger: Logger): void {
  logger.info('[sign] Generating fresh signing material...');
  const materialDir = path.join(projectDir, 'signatures', 'material');
  if (fs.existsSync(materialDir)) {
    fs.rmSync(materialDir, { recursive: true, force: true });
  }
  createMaterial(materialDir);
}

/** What the signing material in a `signatures` directory amounts to, for a one-line summary. */
export interface SigningMaterialSummary {
  /** The profile's type: `release` for the SDK's template. */
  profileType?: string;
  apl?: string;
  /**
   * The end of the profile's validity window. The SDK's template carries a fixed
   * one that ended in 2023, which OpenHarmony devices do not enforce.
   */
  profileNotAfter?: Date;
  /** When the certificate that signs HAPs expires. */
  certificateNotAfter?: Date;
}

/** @internal exposed for tests. */
export function summarizeSigningMaterial(signaturesDir: string, kind: SigningKind): SigningMaterialSummary {
  const profile = readProvisionProfile(path.join(signaturesDir, 'app1-profile.p7b'));
  let leaf;
  try {
    leaf = leafCertificateOf(fs.readFileSync(path.join(signaturesDir, SIGNING_KIND_CONFIG[kind].certBasename), 'utf8'));
  } catch {
    leaf = null;
  }
  return {
    profileType: profile?.type,
    apl: profile?.apl,
    profileNotAfter: profile?.notAfter,
    certificateNotAfter: leaf ? new Date(leaf.validTo) : undefined,
  };
}

/** `release profile, apl normal; certificate valid until 2049-12-31 12:21 UTC`. Empty when nothing is known. */
export function describeSigningMaterial(summary: SigningMaterialSummary): string {
  const profile = [summary.profileType && `${summary.profileType} profile`, summary.apl && `apl ${summary.apl}`]
    .filter(Boolean)
    .join(', ');
  const cert = summary.certificateNotAfter && `certificate valid until ${formatUtc(summary.certificateNotAfter)}`;
  return [profile, cert].filter(Boolean).join('; ');
}

export interface GenerateSigningConfigsResult extends SigningMaterialSummary {
  signaturesDir: string;
  kind: SigningKind;
}

/**
 * Generate signing configs for an OpenHarmony project: copies certs, signs the profile,
 * generates the signing material, and writes the resulting `signingConfigs` entry into
 * `build-profile.json5`.
 *
 * Requires `java` on PATH (the OpenHarmony hap-sign-tool ships as a .jar).
 */
export function generateSigningConfigs(options: GenerateSigningConfigsOptions): GenerateSigningConfigsResult {
  const { projectDir, sdkHome } = options;
  const logger = options.logger ?? noopLogger;
  const apl: Apl = options.apl ?? 'normal';
  if (!APL_VALUES.includes(apl)) {
    throw new OniroError(`Invalid apl '${apl}'. Expected one of: ${APL_VALUES.join(', ')}.`);
  }
  const appFeature: AppFeature = resolveAppFeature(apl, options.appFeature);
  if (!APP_FEATURE_VALUES.includes(appFeature)) {
    throw new OniroError(
      `Invalid appFeature '${appFeature}'. Expected one of: ${APP_FEATURE_VALUES.join(', ')}.`,
    );
  }

  const sdkVersion = detectProjectSdkVersion(projectDir, logger, options.product);
  if (!sdkVersion) {
    throw new OniroError(
      `Could not detect project SDK version (compileSdkVersion missing ${
        options.product ? `for product '${options.product}' ` : ''
      }in build-profile.json5).`,
    );
  }

  const sdkPath = path.join(sdkHome, String(sdkVersion));
  if (!fs.existsSync(sdkPath)) {
    throw new SdkNotInstalledError(String(sdkVersion), sdkPath, ALL_SDKS.find((s) => s.api === String(sdkVersion))?.version);
  }

  const paths = sdkSigningFiles(sdkPath);

  const kind = pickSigningKind(apl);
  const passwords = options.passwords ?? DEFAULT_PASSWORDS;

  logger.info('[sign] Starting signing configuration generation...');
  const signaturesDir = path.join(projectDir, 'signatures');
  copySigningFiles(signaturesDir, paths, kind, logger, options.applicationCertPath);
  modifyProfileTemplate(projectDir, apl, appFeature, logger, {
    kind,
    acls: options.acls,
    appPrivilegeCapabilities: options.appPrivilegeCapabilities,
  });
  generateP7bFile(signaturesDir, paths, logger, passwords);
  prepareMaterialDirectory(projectDir, logger);
  updateBuildProfile(projectDir, kind, logger, passwords);
  logger.info('[sign] Signing configuration generated successfully.');
  return { signaturesDir, kind, ...summarizeSigningMaterial(signaturesDir, kind) };
}
