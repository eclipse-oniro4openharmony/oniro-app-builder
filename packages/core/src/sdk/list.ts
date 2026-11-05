import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_SDKS } from './constants.js';
import { getSdkRootDir } from './paths.js';
import { getOsFolder } from './platform.js';
import type { ConfigProvider } from '../ports/config.js';
import { findHarmonyOsSdk, type HarmonyOsSdkSource } from '../harmonyos/sdk.js';

export interface SdkInfo {
  version: string;
  api: string;
  installed: boolean;
}

/**
 * List supported SDKs annotated with whether they are installed for the current OS.
 * Sorted by API descending (newest first).
 */
export function getSupportedSdksForUi(config: ConfigProvider): SdkInfo[] {
  const base = path.join(getSdkRootDir(config), getOsFolder());
  return ALL_SDKS.map((sdk) => ({
    version: sdk.version,
    api: sdk.api,
    installed: fs.existsSync(path.join(base, sdk.api)),
  })).sort((a, b) => Number(b.api) - Number(a.api));
}

/** The HarmonyOS SDK on this machine, in the shape `sdk list` prints. */
export interface HarmonyOsSdkListing {
  flavour: 'HarmonyOS';
  /** e.g. `HarmonyOS 6.1.1`. */
  displayName?: string;
  /** The release, e.g. `6.1.1`. */
  version?: string;
  /** e.g. `24`. */
  api?: string;
  installed: true;
  /** The SDK directory hvigor receives as `DEVECO_SDK_HOME`. */
  path: string;
  /** Where it was found; `cmdtools` for the command-line tools at `cmdToolsPath`. */
  source?: HarmonyOsSdkSource;
}

/**
 * The HarmonyOS SDK a HarmonyOS build would use, or null. `sdk install` does not
 * manage it: it ships with the HarmonyOS command-line tools (`cmdtools`) or
 * DevEco Studio (#21).
 */
export function getHarmonyOsSdkListing(config: ConfigProvider): HarmonyOsSdkListing | null {
  const sdk = findHarmonyOsSdk({ config });
  if (!sdk) return null;
  const listing: HarmonyOsSdkListing = { flavour: 'HarmonyOS', installed: true, path: sdk.sdkPath };
  if (sdk.displayName) listing.displayName = sdk.displayName;
  const release = sdk.version?.replace(/\(\d+\)$/, '');
  if (release) listing.version = release;
  if (sdk.apiVersion) listing.api = sdk.apiVersion;
  if (sdk.source) listing.source = sdk.source;
  return listing;
}

/**
 * Return the SDK versions that have at least one OS-folder install in `sdkRootDir`.
 * Scans `linux`, `darwin`, `windows` so the list is consistent across machines that
 * share an SDK root over a network mount.
 */
export function getInstalledSdks(config: ConfigProvider): string[] {
  const sdkRoot = getSdkRootDir(config);
  const versions = new Set<string>();
  if (!fs.existsSync(sdkRoot)) return [];

  for (const osFolder of ['linux', 'darwin', 'windows'] as const) {
    const osPath = path.join(sdkRoot, osFolder);
    if (!fs.existsSync(osPath) || !fs.statSync(osPath).isDirectory()) continue;
    for (const api of fs.readdirSync(osPath)) {
      const apiPath = path.join(osPath, api);
      if (fs.statSync(apiPath).isDirectory()) versions.add(api);
    }
  }
  return ALL_SDKS.filter((sdk) => versions.has(sdk.api)).map((sdk) => sdk.version);
}
