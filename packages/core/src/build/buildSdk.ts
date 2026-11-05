import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import type { RuntimeOs } from '../harmonyos/target.js';
import { findHarmonyOsSdk } from '../harmonyos/sdk.js';
import { resolveProjectSdkDir } from '../sdk/detectProjectSdk.js';
import { ALL_SDKS } from '../sdk/constants.js';

/** The SDK a build compiles against, as `build --json` reports it (#22). */
export interface BuildSdk {
  runtimeOS: RuntimeOs;
  /** e.g. `HarmonyOS 6.1.1`, `OpenHarmony 5.1.0`. */
  displayName?: string;
  /** The release as the SDK names it: `6.1.1(24)` for HarmonyOS, the build (`5.1.0.107`) for OpenHarmony. */
  version?: string;
  /** e.g. `24`. */
  api?: string;
  /** The SDK directory: `DEVECO_SDK_HOME` for HarmonyOS, `<sdk home>/<api>` for OpenHarmony. */
  path: string;
}

/** `{ apiVersion, version }` of an OpenHarmony SDK API folder, from a component's `oh-uni-package.json`. */
function readOhUniPackage(apiDir: string): { apiVersion?: string; version?: string } {
  for (const component of ['ets', 'toolchains', 'js', 'native']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(apiDir, component, 'oh-uni-package.json'), 'utf8')) as {
        apiVersion?: unknown;
        version?: unknown;
      };
      const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) || undefined : undefined);
      return { apiVersion: text(pkg.apiVersion), version: text(pkg.version) };
    } catch {
      // Try the next component.
    }
  }
  return {};
}

/**
 * The SDK a build of `projectDir` uses, found the way the build finds it: the
 * HarmonyOS SDK for a HarmonyOS product, else the OpenHarmony API folder for the
 * project's compileSdkVersion. Undefined when it cannot be told.
 */
export function resolveBuildSdk(opts: {
  config: ConfigProvider;
  projectDir: string;
  runtimeOS: RuntimeOs;
  logger?: Logger;
}): BuildSdk | undefined {
  if (opts.runtimeOS === 'HarmonyOS') {
    const sdk = findHarmonyOsSdk({ config: opts.config, logger: opts.logger });
    if (!sdk) return undefined;
    const out: BuildSdk = { runtimeOS: 'HarmonyOS', path: sdk.sdkPath };
    if (sdk.displayName) out.displayName = sdk.displayName;
    if (sdk.version) out.version = sdk.version;
    if (sdk.apiVersion) out.api = sdk.apiVersion;
    return out;
  }
  const dir = resolveProjectSdkDir(opts.config, opts.projectDir);
  if (!dir) return undefined;
  const pkg = readOhUniPackage(dir);
  const api = pkg.apiVersion ?? path.basename(dir);
  const release = ALL_SDKS.find((s) => s.api === api)?.version;
  const out: BuildSdk = { runtimeOS: 'OpenHarmony', path: dir, api };
  out.displayName = release ? `OpenHarmony ${release}` : 'OpenHarmony';
  if (pkg.version) out.version = pkg.version;
  return out;
}

/** `HarmonyOS 5.1.0 (API 18) at <path>`. */
export function describeBuildSdk(sdk: BuildSdk): string {
  return `${sdk.displayName ?? sdk.runtimeOS}${sdk.api ? ` (API ${sdk.api})` : ''} at ${sdk.path}`;
}
