/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/signature/signature-tool.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../../ports/logger.js';
import { OniroError } from '../../ports/errors.js';
import { runProcess } from '../../hdc/exec.js';
import type { HarmonyOsSdk } from '../sdk.js';
import { findJava } from '../java.js';

/** Alias of the key pair inside the generated p12. */
export const KEY_ALIAS = 'debugKey';
export const SIGN_ALG = 'SHA256withECDSA';

/**
 * hap-sign-tool argv with password values masked, for logging.
 *
 * @internal exposed for tests.
 */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, i) => (args[i - 1] === '-keyPwd' || args[i - 1] === '-keystorePwd' ? '******' : arg));
}

/** The SDK's `hap-sign-tool.jar`; throws when the SDK lacks it. */
function hapSignToolJar(sdk: HarmonyOsSdk): string {
  const jar = path.join(sdk.sdkPath, 'default', 'openharmony', 'toolchains', 'lib', 'hap-sign-tool.jar');
  if (!fs.existsSync(jar)) {
    throw new OniroError(`hap-sign-tool.jar not found at ${jar}; the HarmonyOS SDK looks incomplete.`);
  }
  return jar;
}

/** Run one hap-sign-tool subcommand against the keystore at `p12Path`, logging it with the passwords masked. */
async function runHapSignTool(opts: {
  sdk: HarmonyOsSdk;
  what: string;
  args: string[];
  p12Path: string;
  keyPwd: string;
  logger: Logger;
}): Promise<void> {
  const jar = hapSignToolJar(opts.sdk);
  const java = findJava(opts.sdk);
  const argv = ['-jar', jar, ...opts.args, '-keyAlias', KEY_ALIAS, '-keystoreFile', opts.p12Path, '-keystorePwd', opts.keyPwd, '-keyPwd', opts.keyPwd];
  opts.logger.debug(`[harmonyos] ${java} ${redactArgs(argv).join(' ')}`);
  const result = await runProcess({ command: java, args: argv, timeoutMs: 120_000, logger: opts.logger });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new OniroError(`hap-sign-tool failed to ${opts.what} (exit ${result.code}).${detail ? `\n${detail}` : ''}`);
  }
}

/**
 * Generate the local p12 keystore and the CSR AGC turns into a certificate.
 * Returns the random keystore password in the clear; the caller encrypts it
 * before it is stored, and it is never logged.
 */
export async function generateKeystoreAndCsr(opts: {
  sdk: HarmonyOsSdk;
  p12Path: string;
  csrPath: string;
  logger: Logger;
}): Promise<{ keyPwd: string; csr: string }> {
  hapSignToolJar(opts.sdk);
  findJava(opts.sdk);
  const keyPwd = crypto.randomBytes(12).toString('base64url').replaceAll(/[-_]/g, '');
  fs.mkdirSync(path.dirname(opts.p12Path), { recursive: true, mode: 0o700 });
  const run = (what: string, args: string[]) => runHapSignTool({ ...opts, what, args, keyPwd });

  opts.logger.info('[harmonyos] Generating the local keystore and certificate signing request...');
  await run('generate the key pair', ['generate-keypair', '-keyAlg', 'ECC', '-keySize', 'NIST-P-256']);
  await run('generate the CSR', ['generate-csr', '-subject', 'CN=DebugKey', '-signAlg', SIGN_ALG, '-outFile', opts.csrPath]);
  return { keyPwd, csr: fs.readFileSync(opts.csrPath, 'utf8') };
}

/**
 * Sign the HAP at `inFile` into `outFile` with AGC-issued material, as hvigor's
 * SignHap task does. A HAP that is already signed has its signature replaced.
 */
export async function signHapFile(opts: {
  sdk: HarmonyOsSdk;
  inFile: string;
  outFile: string;
  cerPath: string;
  profilePath: string;
  p12Path: string;
  keyPwd: string;
  logger: Logger;
}): Promise<void> {
  await runHapSignTool({
    ...opts,
    what: `sign ${opts.inFile}`,
    args: [
      'sign-app',
      '-mode', 'localSign',
      '-signAlg', SIGN_ALG,
      '-appCertFile', opts.cerPath,
      '-profileFile', opts.profilePath,
      '-inFile', opts.inFile,
      '-outFile', opts.outFile,
    ],
  });
}
