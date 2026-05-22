import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_SDKS } from './constants.js';
import { getSdkRootDir } from './paths.js';
import { getOsFolder } from './platform.js';
import type { ConfigProvider } from '../ports/config.js';

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
