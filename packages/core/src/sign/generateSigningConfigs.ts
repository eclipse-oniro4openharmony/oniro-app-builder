import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSON5 from 'json5';
import { encryptPwd, createMaterial } from './encryptKey.js';
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
  /** Optional logger; defaults to no-op. */
  logger?: Logger;
}

function copyFilesToProject(
  projectDir: string,
  paths: { keystore: string; profileCert: string; unsignedProfileTemplate: string },
  logger: Logger,
): void {
  logger.info('[sign] Copying signing material into project...');
  const signaturesDir = path.join(projectDir, 'signatures');
  fs.mkdirSync(signaturesDir, { recursive: true });

  fs.copyFileSync(paths.keystore, path.join(signaturesDir, 'OpenHarmony.p12'));
  fs.copyFileSync(paths.profileCert, path.join(signaturesDir, 'OpenHarmonyProfileRelease.pem'));
  fs.copyFileSync(paths.unsignedProfileTemplate, path.join(signaturesDir, 'UnsgnedReleasedProfileTemplate.json'));
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

/** @internal exposed for tests. */
export function modifyProfileTemplate(
  projectDir: string,
  apl: Apl,
  appFeature: AppFeature,
  logger: Logger,
): void {
  logger.info(`[sign] Modifying profile template (apl=${apl}, app-feature=${appFeature})...`);
  const appJsonPath = path.join(projectDir, 'AppScope/app.json5');
  const profileTemplatePath = path.join(projectDir, 'signatures/UnsgnedReleasedProfileTemplate.json');
  const profileCertFilePath = path.join(projectDir, 'signatures/OpenHarmonyProfileRelease.pem');

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

  const certContent = fs.readFileSync(profileCertFilePath, 'utf-8');
  const certs = certContent.split('-----END CERTIFICATE-----');
  if (certs.length < 3) {
    throw new OniroError(`${profileCertFilePath} does not contain enough certificates.`);
  }
  const thirdCert = certs[2]!.trim() + '\n-----END CERTIFICATE-----\n';
  profileTemplate['bundle-info']['distribution-certificate'] = thirdCert;

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

function updateBuildProfile(projectDir: string, logger: Logger): void {
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

  buildProfile.app = buildProfile.app ?? {};
  buildProfile.app.signingConfigs = [
    {
      name: 'default',
      material: {
        certpath: './signatures/OpenHarmonyProfileRelease.pem',
        storePassword: encryptedStorePassword,
        keyAlias: 'openharmony application profile release',
        keyPassword: encryptedKeyPassword,
        profile: './signatures/app1-profile.p7b',
        signAlg: 'SHA256withECDSA',
        storeFile: './signatures/OpenHarmony.p12',
      },
    },
  ];

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

  logger.info('[sign] Starting signing configuration generation...');
  copyFilesToProject(projectDir, paths, logger);
  modifyProfileTemplate(projectDir, apl, appFeature, logger);
  generateP7bFile(projectDir, paths, logger);
  prepareMaterialDirectory(projectDir, logger);
  updateBuildProfile(projectDir, logger);
  logger.info('[sign] Signing configuration generated successfully.');
}
