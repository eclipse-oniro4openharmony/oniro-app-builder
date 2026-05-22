import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSdkRootDir } from './paths.js';
import type { ConfigProvider } from '../ports/config.js';

/**
 * Remove an installed SDK for a given API level, across all OS folders.
 * Returns true if at least one folder was deleted.
 */
export function removeSdk(config: ConfigProvider, api: string): boolean {
  const sdkRoot = getSdkRootDir(config);
  let removed = false;
  for (const osFolder of ['linux', 'darwin', 'windows']) {
    const sdkPath = path.join(sdkRoot, osFolder, api);
    if (fs.existsSync(sdkPath)) {
      fs.rmSync(sdkPath, { recursive: true, force: true });
      removed = true;
    }
  }
  return removed;
}
