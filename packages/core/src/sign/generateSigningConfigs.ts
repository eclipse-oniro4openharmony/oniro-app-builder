import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSON5 from 'json5';
import { encryptPwd, createMaterial } from './encryptKey.js';
import { OPEN_HARMONY_APPLICATION_CERT } from './applicationCert.js';
import { detectProjectSdkVersion } from '../sdk/detectProjectSdk.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';

/** Ability Privilege Level written into the profile's `bundle-info.apl`. */
export type Apl = 'normal' | 'system_basic' | 'system_core';

/** App feature written into the profile's `bundle-info.app-feature`. */
export type AppFeature = 'hos_normal_app' | 'hos_system_app';

export const APL_VALUES: readonly Apl[] = ['normal', 'system_basic', 'system_core'];
export const APP_FEATURE_VALUES: readonly AppFeature[] = ['hos_normal_app', 'hos_system_app'];

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

const SIGNING_KIND_CONFIG: Record<SigningKind, SigningKindConfig> = {
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
  /** Optional logger; defaults to no-op. */
  logger?: Logger;
}

function copyFilesToProject(
  projectDir: string,
  paths: { keystore: string; profileCert: string; unsignedProfileTemplate: string },
  kind: SigningKind,
  logger: Logger,
): void {
  logger.info('[sign] Copying signing material into project...');
  const signaturesDir = path.join(projectDir, 'signatures');
  fs.mkdirSync(signaturesDir, { recursive: true });

  fs.copyFileSync(paths.keystore, path.join(signaturesDir, 'OpenHarmony.p12'));
  fs.copyFileSync(paths.profileCert, path.join(signaturesDir, 'OpenHarmonyProfileRelease.pem'));
  fs.copyFileSync(paths.unsignedProfileTemplate, path.join(signaturesDir, 'UnsgnedReleasedProfileTemplate.json'));

  if (kind === 'application-release') {
    fs.writeFileSync(
      path.join(signaturesDir, 'OpenHarmonyApplication.cer'),
      OPEN_HARMONY_APPLICATION_CERT,
    );
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
  options: { kind?: SigningKind; acls?: string[] } = {},
): void {
  const kind = options.kind ?? pickSigningKind(apl);
  logger.info(`[sign] Modifying profile template (apl=${apl}, app-feature=${appFeature}, kind=${kind})...`);
  const appJsonPath = path.join(projectDir, 'AppScope/app.json5');
  const profileTemplatePath = path.join(projectDir, 'signatures/UnsgnedReleasedProfileTemplate.json');

  if (!fs.existsSync(appJsonPath)) {
    throw new OniroError(`${appJsonPath} does not exist.`);
  }

  let appJson: { app?: { bundleName?: string } };
  try {
    appJson = JSON5.parse(fs.readFileSync(appJsonPath, 'utf-8'));
  } catch (e) {
    throw new OniroError(`Error parsing ${appJsonPath}: ${(e as Error).message}`, e);
  }

  let profileTemplate: {
    'bundle-info'?: {
      'bundle-name'?: string;
      'distribution-certificate'?: string;
      apl?: string;
      'app-feature'?: string;
    };
    acls?: { 'allowed-acls'?: string[] };
  };
  try {
    profileTemplate = JSON.parse(fs.readFileSync(profileTemplatePath, 'utf-8'));
  } catch (e) {
    throw new OniroError(`Error parsing ${profileTemplatePath}: ${(e as Error).message}`, e);
  }

  if (!appJson.app?.bundleName) {
    throw new OniroError('app.json5 does not contain app.bundleName.');
  }
  if (!profileTemplate['bundle-info']) {
    throw new OniroError('UnsgnedReleasedProfileTemplate.json is missing the bundle-info section.');
  }

  profileTemplate['bundle-info']['bundle-name'] = appJson.app.bundleName;
  profileTemplate['bundle-info']['apl'] = apl;
  profileTemplate['bundle-info']['app-feature'] = appFeature;

  const distCertChainPath = path.join(
    projectDir,
    'signatures',
    SIGNING_KIND_CONFIG[kind].certBasename,
  );
  profileTemplate['bundle-info']['distribution-certificate'] = extractLeafCertificate(distCertChainPath);

  if (options.acls !== undefined) {
    profileTemplate.acls = profileTemplate.acls ?? {};
    profileTemplate.acls['allowed-acls'] = options.acls;
  }

  fs.writeFileSync(profileTemplatePath, JSON.stringify(profileTemplate, null, 2));
}

function generateP7bFile(
  projectDir: string,
  paths: { signTool: string; profileCert: string; keystore: string },
  logger: Logger,
): void {
  logger.info('[sign] Generating P7b profile via hap-sign-tool...');
  const signaturesDir = path.join(projectDir, 'signatures');
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
    '-keyPwd', '123456',
    '-keystorePwd', '123456',
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

function updateBuildProfile(projectDir: string, kind: SigningKind, logger: Logger): void {
  logger.info('[sign] Writing signing configs into build-profile.json5...');
  const materialDir = path.join(projectDir, 'signatures', 'material');
  const buildProfilePath = path.join(projectDir, 'build-profile.json5');

  const encryptedStorePassword = encryptPwd('123456', materialDir);
  const encryptedKeyPassword = encryptPwd('123456', materialDir);

  let buildProfile: { app?: { signingConfigs?: unknown[] } } = { app: {} };
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

/**
 * Generate signing configs for an OpenHarmony project: copies certs, signs the profile,
 * generates the signing material, and writes the resulting `signingConfigs` entry into
 * `build-profile.json5`.
 *
 * Requires `java` on PATH (the OpenHarmony hap-sign-tool ships as a .jar).
 */
export function generateSigningConfigs(options: GenerateSigningConfigsOptions): void {
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

  const sdkVersion = detectProjectSdkVersion(projectDir, logger);
  if (!sdkVersion) {
    throw new OniroError(
      'Could not detect project SDK version (compileSdkVersion missing in build-profile.json5).',
    );
  }

  const sdkPath = path.join(sdkHome, String(sdkVersion));
  if (!fs.existsSync(sdkPath)) {
    throw new OniroError(`SDK path does not exist: ${sdkPath}`);
  }

  const paths = {
    signTool: path.join(sdkPath, 'toolchains/lib/hap-sign-tool.jar'),
    keystore: path.join(sdkPath, 'toolchains/lib/OpenHarmony.p12'),
    profileCert: path.join(sdkPath, 'toolchains/lib/OpenHarmonyProfileRelease.pem'),
    unsignedProfileTemplate: path.join(sdkPath, 'toolchains/lib/UnsgnedReleasedProfileTemplate.json'),
  };

  const kind = pickSigningKind(apl);

  logger.info('[sign] Starting signing configuration generation...');
  copyFilesToProject(projectDir, paths, kind, logger);
  modifyProfileTemplate(projectDir, apl, appFeature, logger, { kind, acls: options.acls });
  generateP7bFile(projectDir, paths, logger);
  prepareMaterialDirectory(projectDir, logger);
  updateBuildProfile(projectDir, kind, logger);
  logger.info('[sign] Signing configuration generated successfully.');
}
