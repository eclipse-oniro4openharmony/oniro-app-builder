import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OniroError } from '../ports/errors.js';
import { readZipEntry } from '../sdk/extract.js';

/** What signing needs to know about a built HAP. */
export interface HapSigningInfo {
  bundleName: string;
  /** Every `module.requestPermissions[].name` the HAP declares. */
  requestedPermissions: string[];
  /** `app.compileSdkType`: `OpenHarmony` or `HarmonyOS`; older toolchains do not write it. */
  compileSdkType?: string;
  /** `app.targetAPIVersion`, e.g. 23. */
  targetApiVersion?: number;
}

/**
 * The bundle name and requested permissions in the text of a HAP's `module.json`.
 *
 * @internal exposed for tests.
 */
export function parseHapModuleJson(text: string, hapPath: string): HapSigningInfo {
  let parsed: {
    app?: { bundleName?: unknown; compileSdkType?: unknown; targetAPIVersion?: unknown };
    module?: { requestPermissions?: Array<{ name?: unknown }> };
  };
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new OniroError(`The module.json in ${hapPath} is not valid JSON: ${(err as Error).message}`, err);
  }
  const bundleName = parsed.app?.bundleName;
  if (typeof bundleName !== 'string' || !bundleName) {
    throw new OniroError(`The module.json in ${hapPath} names no app.bundleName.`);
  }
  const requested = Array.isArray(parsed.module?.requestPermissions) ? parsed.module.requestPermissions : [];
  const { compileSdkType, targetAPIVersion } = parsed.app ?? {};
  return {
    bundleName,
    requestedPermissions: requested
      .map((p) => p?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
    compileSdkType: typeof compileSdkType === 'string' && compileSdkType ? compileSdkType : undefined,
    targetApiVersion: typeof targetAPIVersion === 'number' ? targetAPIVersion : undefined,
  };
}

/** Read a HAP's bundle name and requested permissions from the `module.json` packed in it. */
export async function readHapSigningInfo(hapPath: string): Promise<HapSigningInfo> {
  if (!fs.existsSync(hapPath)) throw new OniroError(`${hapPath} does not exist.`);
  let moduleJson: Buffer | undefined;
  try {
    moduleJson = await readZipEntry(hapPath, (n) => n === 'module.json');
    if (!moduleJson && (await readZipEntry(hapPath, (n) => n === 'config.json'))) {
      throw new OniroError(
        `${hapPath} is an FA-model HAP (config.json, no module.json). Only stage-model HAPs can be signed without their project.`,
      );
    }
  } catch (err) {
    if (err instanceof OniroError) throw err;
    throw new OniroError(`Could not read ${hapPath} as a HAP: ${(err as Error).message}`, err);
  }
  if (!moduleJson) throw new OniroError(`${hapPath} holds no module.json, so it is not a HAP.`);
  return parseHapModuleJson(moduleJson.toString('utf8'), hapPath);
}

/**
 * Where the signed copy of `hapPath` goes by default: next to it, as hvigor names
 * its outputs (`entry-default-unsigned.hap` → `entry-default-signed.hap`,
 * `app.hap` → `app-signed.hap`). Never the input itself: `entry-default-signed.hap`
 * becomes `entry-default-resigned.hap`, so re-signing in place takes an explicit `--out`.
 */
export function defaultSignedHapPath(hapPath: string): string {
  const dir = path.dirname(hapPath);
  const name = path.basename(hapPath);
  if (/-signed\.hap$/i.test(name)) return path.join(dir, name.replace(/-signed\.hap$/i, '-resigned.hap'));
  return path.join(dir, `${name.replace(/(-unsigned)?\.hap$/i, '')}-signed.hap`);
}

/**
 * Have `sign` write a HAP to a temporary sibling of `outPath`, then move it into
 * place. The input may be the output, and a failed signing must not leave a
 * half-written HAP under the final name. Creates the output's directory.
 */
export async function writeHapAtomically(outPath: string, sign: (tmpPath: string) => Promise<void> | void): Promise<void> {
  const dir = path.dirname(outPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new OniroError(`Cannot create ${dir} for the signed HAP: ${(err as Error).message}`, err);
  }
  const tmpPath = path.join(dir, `.${path.basename(outPath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await sign(tmpPath);
    fs.renameSync(tmpPath, outPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}
