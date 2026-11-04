import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { isValidBundleName } from '../project/validators.js';
import { defaultSignedHapPath, readHapSigningInfo, writeHapAtomically } from './hapInfo.js';
import {
  APL_VALUES,
  APP_FEATURE_VALUES,
  DEFAULT_PASSWORDS,
  SIGNING_KIND_CONFIG,
  applyProfileTemplate,
  copySigningFiles,
  generateP7bFile,
  pickSigningKind,
  resolveAppFeature,
  sdkSigningFiles,
  type Apl,
  type AppFeature,
  type SigningKind,
  type SigningPasswords,
} from './generateSigningConfigs.js';

/**
 * The installed SDK to sign with: the API level the HAP targets when installed,
 * else the newest. The keystore, certificates and profile template are the same
 * in every release, so any SDK with `hap-sign-tool.jar` signs alike.
 *
 * @internal exposed for tests.
 */
export function pickSigningSdk(sdkHome: string, targetApiVersion?: number): { api: string; sdkPath: string } | null {
  let apis: string[];
  try {
    apis = fs.readdirSync(sdkHome).filter((api) => /^\d+$/.test(api));
  } catch {
    return null;
  }
  const usable = apis
    .filter((api) => fs.existsSync(sdkSigningFiles(path.join(sdkHome, api)).signTool))
    .sort((a, b) => Number(b) - Number(a));
  const api = usable.find((a) => targetApiVersion !== undefined && Number(a) === targetApiVersion) ?? usable[0];
  return api ? { api, sdkPath: path.join(sdkHome, api) } : null;
}

export interface SignOpenHarmonyHapOptions {
  /** The HAP to sign: unsigned, or signed with other material. */
  hapPath: string;
  /** Where to write the signed HAP. Default {@link defaultSignedHapPath}. May equal `hapPath`. */
  outPath?: string;
  /** The OS-specific SDK home (the folder holding API-version subfolders). */
  sdkHome: string;
  /** As for {@link generateSigningConfigs}. Default `normal`. */
  apl?: Apl;
  appFeature?: AppFeature;
  acls?: string[];
  appPrivilegeCapabilities?: string[];
  passwords?: SigningPasswords;
  /** Override the bundled application cert chain (application-release kind only). */
  applicationCertPath?: string;
  logger?: Logger;
}

export interface SignOpenHarmonyHapResult {
  bundleName: string;
  outPath: string;
  /** API level of the SDK whose signing material was used. */
  sdkApi: string;
  kind: SigningKind;
}

/**
 * Sign a prebuilt HAP, with no project, for OpenHarmony devices: the SDK's
 * development certificate, as `generateSigningConfigs` sets up for a project,
 * and a profile for the HAP's own bundle name. Fully offline; the material is
 * generated in a temporary directory and removed afterwards, since it costs
 * nothing to make again. Requires `java` on PATH.
 */
export async function signOpenHarmonyHap(opts: SignOpenHarmonyHapOptions): Promise<SignOpenHarmonyHapResult> {
  const logger = opts.logger ?? noopLogger;
  const hapPath = path.resolve(opts.hapPath);
  const outPath = path.resolve(opts.outPath ?? defaultSignedHapPath(hapPath));
  const apl: Apl = opts.apl ?? 'normal';
  if (!APL_VALUES.includes(apl)) {
    throw new OniroError(`Invalid apl '${apl}'. Expected one of: ${APL_VALUES.join(', ')}.`);
  }
  const appFeature = resolveAppFeature(apl, opts.appFeature);
  if (!APP_FEATURE_VALUES.includes(appFeature)) {
    throw new OniroError(`Invalid appFeature '${appFeature}'. Expected one of: ${APP_FEATURE_VALUES.join(', ')}.`);
  }

  const info = await readHapSigningInfo(hapPath);
  if (info.compileSdkType === 'HarmonyOS') {
    throw new OniroError(
      `${hapPath} was built for HarmonyOS, which needs a certificate from AppGallery Connect: run \`oniro-app auth login\` once, then \`oniro-app sign --harmonyos --hap\`.`,
    );
  }
  if (!isValidBundleName(info.bundleName)) {
    throw new OniroError(`${hapPath} names an invalid bundle name '${info.bundleName}'.`);
  }

  const sdk = pickSigningSdk(opts.sdkHome, info.targetApiVersion);
  if (!sdk) {
    throw new OniroError(
      `No OpenHarmony SDK with hap-sign-tool.jar under ${opts.sdkHome}; install one with \`oniro-app sdk install\`.`,
    );
  }
  const files = sdkSigningFiles(sdk.sdkPath);
  const kind = pickSigningKind(apl);
  const passwords = opts.passwords ?? DEFAULT_PASSWORDS;
  logger.info(`[sign] Signing ${path.basename(hapPath)} as ${info.bundleName} with the API ${sdk.api} SDK's material...`);

  const signaturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sign-hap-'));
  try {
    copySigningFiles(signaturesDir, files, kind, logger, opts.applicationCertPath);
    applyProfileTemplate(signaturesDir, info.bundleName, apl, appFeature, logger, {
      kind,
      acls: opts.acls,
      appPrivilegeCapabilities: opts.appPrivilegeCapabilities,
    });
    generateP7bFile(signaturesDir, files, logger, passwords);

    logger.info('[sign] Signing the HAP via hap-sign-tool...');
    const { hapKeyAlias, certBasename } = SIGNING_KIND_CONFIG[kind];
    await writeHapAtomically(outPath, (tmpPath) => {
      const args = [
        '-jar', files.signTool,
        'sign-app',
        '-mode', 'localSign',
        '-keyAlias', hapKeyAlias,
        '-signAlg', 'SHA256withECDSA',
        '-appCertFile', path.join(signaturesDir, certBasename),
        '-profileFile', path.join(signaturesDir, 'app1-profile.p7b'),
        '-inFile', hapPath,
        '-outFile', tmpPath,
        '-keystoreFile', path.join(signaturesDir, 'OpenHarmony.p12'),
        '-keyPwd', passwords.key,
        '-keystorePwd', passwords.store,
      ];
      try {
        execFileSync('java', args, { stdio: 'inherit' });
      } catch (e) {
        throw new OniroError(
          `hap-sign-tool failed to sign ${hapPath}. Ensure a JDK (with java) is on PATH. Underlying error: ${(e as Error).message}`,
          e,
        );
      }
    });
  } finally {
    fs.rmSync(signaturesDir, { recursive: true, force: true });
  }

  logger.info(`[sign] Wrote ${outPath}.`);
  return { bundleName: info.bundleName, outPath, sdkApi: sdk.api, kind };
}
