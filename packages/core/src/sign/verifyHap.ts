import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { X509Certificate } from 'node:crypto';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { runProcess } from '../hdc/exec.js';
import { getOhosBaseSdkHome } from '../sdk/paths.js';
import { findHarmonyOsSdk } from '../harmonyos/sdk.js';
import { findJava } from '../harmonyos/java.js';
import { formatUtc, parseProvisionProfile } from '../harmonyos/signing/profile.js';
import { readHapSigningInfo } from './hapInfo.js';
import { pickSigningSdk } from './signHap.js';
import { sdkSigningFiles } from './generateSigningConfigs.js';
import { commonNameOf, describeCertificate, orderChain, readPemCertificates, type CertificateInfo } from './certChain.js';

/**
 * Who issued the signing material: the OpenHarmony SDK's development certificate
 * and `pki_internal` profile, which OpenHarmony devices accept and HarmonyOS
 * devices do not; AppGallery Connect, whose chain ends at `Huawei CBG Root CA G2`;
 * or neither.
 */
export type HapSigner = 'openharmony-dev' | 'harmonyos-agc' | 'other';

/** `valid`: exit 0. `invalid` (unsigned, bad signature, expired, mismatched): 1. `unverified` (no java or hap-sign-tool): 2. */
export type HapVerifyStatus = 'valid' | 'invalid' | 'unverified';

export interface HapProfileReport {
  /** `debug` or `release`. */
  type?: string;
  /** `app_gallery` (AGC) or `pki_internal` (the OpenHarmony SDK's). */
  issuer?: string;
  bundleName?: string;
  developerId?: string;
  apl?: string;
  appFeature?: string;
  /** UDIDs a debug profile is limited to; a release profile names none. */
  deviceCount: number;
  notBefore?: Date;
  notAfter?: Date;
  expired: boolean;
  /** Whole days until `notAfter`; negative once past it. */
  daysLeft?: number;
  /**
   * Whether a device refuses the HAP once the profile is out of date. Not for the
   * OpenHarmony SDK's development profile, whose fixed 2020-2023 window
   * OpenHarmony devices ignore.
   */
  expiryEnforced: boolean;
  /** Whether the profile names the certificate that signed the HAP; undefined when it names none. */
  issuedForSigningCertificate?: boolean;
}

export interface VerifyHapResult {
  hapPath: string;
  status: HapVerifyStatus;
  /** Whether the HAP has a signing block at all. */
  signed: boolean;
  /** hap-sign-tool `verify-app` accepted the signature. */
  signatureValid: boolean;
  signer?: HapSigner;
  /** The signing chain, leaf first. */
  chain: CertificateInfo[];
  /** Common name (else subject) of the chain's root. */
  root?: string;
  profile?: HapProfileReport;
  /** The bundle name in the HAP's own module.json. */
  hapBundleName?: string;
  /** `app.compileSdkType` in the HAP's module.json: `OpenHarmony` or `HarmonyOS`, when the toolchain wrote it. */
  hapCompileSdkType?: string;
  /** What makes it `invalid` or `unverified`. Empty when `valid`. */
  problems: string[];
  /** Worth knowing; no effect on `status`. */
  notes: string[];
  /** hap-sign-tool's own error lines, when it refused the HAP. */
  toolErrors: string[];
  signTool?: string;
  java?: string;
}

export interface VerifyHapOptions {
  hapPath: string;
  config: ConfigProvider;
  logger?: Logger;
  /** The time profile and certificate validity is judged at. Default now. */
  now?: Date;
  /** Use this `hap-sign-tool.jar` instead of looking for one. */
  signTool?: string;
  /** Use this java instead of looking for one. */
  java?: string;
}

const DAY_MS = 86_400_000;
const HUAWEI_ROOT = 'Huawei CBG Root CA G2';

/**
 * A `hap-sign-tool.jar` to verify with: an installed OpenHarmony SDK's, else the
 * HarmonyOS SDK's, else the command-line tools'. Any of them verifies any HAP.
 */
export function findHapSignTool(config: ConfigProvider, logger: Logger = noopLogger): string | null {
  const ohos = pickSigningSdk(getOhosBaseSdkHome(config));
  const candidates = [
    ohos && sdkSigningFiles(ohos.sdkPath).signTool,
    findHarmonyOsSdk({ config, logger })?.sdkPath,
    path.join(config.get('cmdToolsPath', defaultPaths.cmdToolsPath()), 'sdk'),
  ].map((p) => (p && !p.endsWith('.jar') ? path.join(p, 'default', 'openharmony', 'toolchains', 'lib', 'hap-sign-tool.jar') : p));
  return candidates.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
}

/** hap-sign-tool's `ERROR - …` lines and `Error Message: …` detail, without the timestamps. */
function toolErrorLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => /\bERROR - (.*)$/.exec(line)?.[1] ?? /^Error Message: (.*)$/.exec(line.trim())?.[1])
    .filter((line): line is string => !!line && line.trim() !== '')
    .map((line) => line.trim());
}

function classifySigner(chain: X509Certificate[], profileIssuer: string | undefined): HapSigner {
  const names = chain.flatMap((c) => [commonNameOf(c.subject), commonNameOf(c.issuer)]);
  if (names.includes(HUAWEI_ROOT) || profileIssuer === 'app_gallery') return 'harmonyos-agc';
  if (names.some((n) => n?.startsWith('OpenHarmony Application')) || profileIssuer === 'pki_internal') {
    return 'openharmony-dev';
  }
  return 'other';
}

/** Problems with the chain's own links and dates. */
function chainProblems(chain: X509Certificate[], now: Date): string[] {
  const problems: string[] = [];
  for (const [i, cert] of chain.entries()) {
    const name = commonNameOf(cert.subject) ?? cert.subject;
    if (now > new Date(cert.validTo)) problems.push(`certificate "${name}" expired on ${formatUtc(new Date(cert.validTo))}`);
    else if (now < new Date(cert.validFrom)) {
      problems.push(`certificate "${name}" is not valid before ${formatUtc(new Date(cert.validFrom))}`);
    }
    const issuer = chain[i + 1] ?? (cert.subject === cert.issuer ? cert : undefined);
    if (issuer && issuer.subject === cert.issuer && !(cert.checkIssued(issuer) && cert.verify(issuer.publicKey))) {
      problems.push(`certificate "${name}" does not verify against its issuer's key`);
    }
  }
  return problems;
}

/**
 * Verify a HAP's signature with the SDK's `hap-sign-tool.jar verify-app`, then
 * read what signed it: the certificate chain, whether it is OpenHarmony
 * development material or AppGallery Connect's, and the provisioning profile's
 * type, bundle, APL, devices and validity. Never throws for a HAP that is
 * unsigned, mis-signed or expired; that is the `status` and `problems`.
 */
export async function verifyHap(opts: VerifyHapOptions): Promise<VerifyHapResult> {
  const logger = opts.logger ?? noopLogger;
  const now = opts.now ?? new Date();
  const hapPath = path.resolve(opts.hapPath);
  const result: VerifyHapResult = {
    hapPath,
    status: 'unverified',
    signed: false,
    signatureValid: false,
    chain: [],
    problems: [],
    notes: [],
    toolErrors: [],
  };
  const unverified = (problem: string): VerifyHapResult => ({ ...result, status: 'unverified', problems: [problem] });

  if (!fs.existsSync(hapPath) || !fs.statSync(hapPath).isFile()) return unverified(`${hapPath} does not exist`);
  const signTool = opts.signTool ?? findHapSignTool(opts.config, logger);
  if (!signTool) {
    return unverified(
      'no hap-sign-tool.jar found: install an OpenHarmony SDK (`oniro-app sdk install`), or the command-line tools',
    );
  }
  result.signTool = signTool;
  let java: string;
  try {
    java = opts.java ?? findJava(findHarmonyOsSdk({ config: opts.config, logger }) ?? undefined);
  } catch (err) {
    return unverified((err as Error).message);
  }
  result.java = java;

  try {
    const info = await readHapSigningInfo(hapPath);
    result.hapBundleName = info.bundleName;
    result.hapCompileSdkType = info.compileSdkType;
  } catch (err) {
    logger.debug(`[verify] Could not read the bundle name from ${hapPath}: ${(err as Error).message}`);
  }

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-verify-'));
  try {
    const cerPath = path.join(out, 'chain.cer');
    const profilePath = path.join(out, 'profile.p7b');
    const args = ['-jar', signTool, 'verify-app', '-inFile', hapPath, '-outCertChain', cerPath, '-outProfile', profilePath];
    logger.debug(`[verify] ${java} ${args.join(' ')}`);
    let run;
    try {
      run = await runProcess({ command: java, args, timeoutMs: 300_000, logger });
    } catch (err) {
      return unverified(`could not run hap-sign-tool: ${(err as Error).message}`);
    }
    const output = `${run.stdout}\n${run.stderr}`;
    result.toolErrors = toolErrorLines(output);
    if (/signature not found|No Hap Signing Block/i.test(output)) {
      result.status = 'invalid';
      result.problems.push('the HAP is not signed: it has no signing block');
      return result;
    }
    result.signed = true;
    result.signatureValid = run.code === 0 && /verify-app success/.test(output);
    if (!result.signatureValid) {
      const why = result.toolErrors.join('; ') || `exit ${run.code}`;
      result.problems.push(`hap-sign-tool rejected the signature: ${why}`);
    }

    const certs = fs.existsSync(cerPath) ? orderChain(readPemCertificates(fs.readFileSync(cerPath, 'utf8'))) : [];
    const profile = fs.existsSync(profilePath) ? parseProvisionProfile(fs.readFileSync(profilePath)) : null;
    if (result.signatureValid && certs.length === 0) result.problems.push('the HAP carries no certificate chain');
    if (result.signatureValid && !profile) result.problems.push('the HAP carries no readable provisioning profile');

    result.chain = certs.map(describeCertificate);
    result.signer = certs.length > 0 || profile ? classifySigner(certs, profile?.issuer) : undefined;
    const top = certs.at(-1);
    if (top) {
      result.root = top.subject === top.issuer ? (commonNameOf(top.subject) ?? top.subject) : commonNameOf(top.issuer);
      if (top.subject !== top.issuer) result.notes.push(`the chain stops below its root, ${result.root}`);
    }
    result.problems.push(...chainProblems(certs, now));
    if (result.hapCompileSdkType === 'HarmonyOS' && result.signer === 'openharmony-dev') {
      result.problems.push(
        'the HAP is built for HarmonyOS but signed with OpenHarmony development material, which a HarmonyOS ' +
          'device refuses: sign it with `oniro-app sign --harmonyos`',
      );
    }

    if (profile) {
      const expiryEnforced = result.signer !== 'openharmony-dev';
      const issuedFor = profile.type === 'debug'
        ? (profile.developmentCertificate ?? profile.distributionCertificate)
        : (profile.distributionCertificate ?? profile.developmentCertificate);
      const issuedForCert = issuedFor ? readPemCertificates(issuedFor)[0] : undefined;
      const report: HapProfileReport = {
        type: profile.type,
        issuer: profile.issuer,
        bundleName: profile.bundleName,
        developerId: profile.developerId,
        apl: profile.apl,
        appFeature: profile.appFeature,
        deviceCount: profile.deviceIds.length,
        notBefore: profile.notBefore,
        notAfter: profile.notAfter,
        expired: !!profile.notAfter && profile.notAfter <= now,
        daysLeft: profile.notAfter ? Math.trunc((profile.notAfter.getTime() - now.getTime()) / DAY_MS) : undefined,
        expiryEnforced,
        issuedForSigningCertificate:
          issuedForCert && certs[0] ? issuedForCert.fingerprint256 === certs[0].fingerprint256 : undefined,
      };
      result.profile = report;

      const kind = profile.type ?? 'provisioning';
      if (report.expired && profile.notAfter) {
        if (expiryEnforced) result.problems.push(`the ${kind} profile expired on ${formatUtc(profile.notAfter)}`);
        else {
          result.notes.push(
            "OpenHarmony devices do not enforce the validity window of the SDK's development profile, " +
              `which ended ${formatUtc(profile.notAfter)}`,
          );
        }
      } else if (expiryEnforced && profile.notBefore && profile.notBefore > now) {
        result.problems.push(`the ${kind} profile is not valid before ${formatUtc(profile.notBefore)}`);
      }
      if (report.issuedForSigningCertificate === false) {
        const named = commonNameOf(issuedForCert!.subject) ?? issuedForCert!.subject;
        result.problems.push(
          `the profile was issued for certificate "${named}", not "${result.chain[0]!.commonName ?? result.chain[0]!.subject}", which signed the HAP`,
        );
      }
      if (result.hapBundleName && profile.bundleName && profile.bundleName !== result.hapBundleName) {
        result.problems.push(`the profile is for bundle ${profile.bundleName}, but the HAP is ${result.hapBundleName}`);
      }
      if (profile.type === 'debug' && result.signer === 'harmonyos-agc') {
        result.notes.push('a debug profile installs only on the devices it names');
      }
    }
    result.status = result.problems.length > 0 ? 'invalid' : 'valid';
    return result;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/** 0 valid, 1 invalid (unsigned, bad signature, expired, mismatched), 2 could not verify. */
export function verifyHapExitCode(result: Pick<VerifyHapResult, 'status'>): number {
  return result.status === 'valid' ? 0 : result.status === 'invalid' ? 1 : 2;
}

const SIGNER_LABEL: Record<HapSigner, string> = {
  'openharmony-dev': 'OpenHarmony development material (the SDK certificate): OpenHarmony devices only',
  'harmonyos-agc': `HarmonyOS, issued by AppGallery Connect (chains to ${HUAWEI_ROOT})`,
  other: 'neither OpenHarmony development material nor AppGallery Connect',
};

function days(n: number): string {
  return `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`;
}

/** {@link verifyHap}'s result as the lines `oniro-app app verify` prints. */
export function formatHapVerification(result: VerifyHapResult): string {
  const verdict = { valid: 'valid', invalid: 'INVALID', unverified: 'could not verify' }[result.status];
  const lines = [`${result.hapPath}: ${verdict}`];
  const row = (key: string, value: string) => lines.push(`  ${(key ? `${key}:` : '').padEnd(13)} ${value}`);
  if (result.status !== 'unverified') {
    row('signature', !result.signed ? 'none (unsigned)' : result.signatureValid ? 'valid' : 'INVALID');
  }
  if (result.signer) row('signer', SIGNER_LABEL[result.signer]);
  result.chain.forEach((c, i) => {
    const role = i === 0 ? 'leaf' : c.selfSigned ? 'root' : 'intermediate';
    row(i === 0 ? 'chain' : '', `${c.commonName ?? c.subject}  [${role}, until ${formatUtc(c.notAfter)}]`);
  });
  const p = result.profile;
  if (p) {
    row('profile', [p.type, p.issuer && `issuer ${p.issuer}`].filter(Boolean).join(', ') || 'unknown type');
    if (p.bundleName) row('bundle', p.bundleName);
    if (p.apl) row('apl', p.apl);
    if (p.appFeature) row('app-feature', p.appFeature);
    row('devices', p.type === 'release' && p.deviceCount === 0 ? 'any (release profile)' : String(p.deviceCount));
    if (p.notAfter) {
      const from = p.notBefore ? `${formatUtc(p.notBefore)} to ` : 'until ';
      const left = p.daysLeft === undefined ? '' : p.expired ? `, expired ${days(p.daysLeft)} ago` : `, ${days(p.daysLeft)} left`;
      row('validity', `${from}${formatUtc(p.notAfter)}${left}${p.expired && !p.expiryEnforced ? ' (not enforced)' : ''}`);
    }
  }
  for (const problem of result.problems) row('problem', problem);
  for (const note of result.notes) row('note', note);
  return `${lines.join('\n')}\n`;
}
