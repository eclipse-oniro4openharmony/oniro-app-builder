import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSdkRootDir } from './paths.js';
import type { ConfigProvider } from '../ports/config.js';
import { apiOfSdkDirName, legacySdkApiDirTarget, listSdkApiDirs } from './apiDir.js';
import { apiOfDottedVersion } from './apiVersion.js';

/**
 * Remove an installed SDK, across all OS folders. An API level (`26`) removes every
 * folder holding that API, so also an API 26+ SDK in both its `<api>` and `<release>`
 * folders; a release (`26.0.0`) removes only that one, in its own folder or the
 * legacy `<api>` one. Returns true if at least one folder was deleted.
 */
export function removeSdk(config: ConfigProvider, api: string): boolean {
  const sdkRoot = getSdkRootDir(config);
  const level = apiOfSdkDirName(api);
  if (level === undefined) return false;
  const release = apiOfDottedVersion(api) !== undefined ? api.trim() : undefined;
  let removed = false;
  for (const osFolder of ['linux', 'darwin', 'windows']) {
    const home = path.join(sdkRoot, osFolder);
    for (const sdk of listSdkApiDirs(home)) {
      if (sdk.api !== level) continue;
      if (release !== undefined && path.basename(sdk.legacy ? legacySdkApiDirTarget(home, level) : sdk.dir) !== release) continue;
      fs.rmSync(sdk.dir, { recursive: true, force: true });
      removed = true;
    }
  }
  return removed;
}
