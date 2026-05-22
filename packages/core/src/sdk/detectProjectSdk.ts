import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import { Logger, noopLogger } from '../ports/logger.js';

/**
 * Detect the SDK API a project targets by reading `build-profile.json5`.
 * Returns the `compileSdkVersion` of the first declared product, or undefined
 * if the file is missing/malformed or no product declares one.
 */
export function detectProjectSdkVersion(projectRoot: string, logger: Logger = noopLogger): number | undefined {
  const buildProfilePath = path.join(projectRoot, 'build-profile.json5');
  if (!fs.existsSync(buildProfilePath)) {
    logger.warn(`build-profile.json5 not found at ${projectRoot}`);
    return undefined;
  }
  try {
    const content = fs.readFileSync(buildProfilePath, 'utf-8');
    const config = JSON5.parse(content) as { app?: { products?: Array<{ compileSdkVersion?: unknown }> } };
    const product = config.app?.products?.[0];
    const v = product?.compileSdkVersion;
    return typeof v === 'number' ? v : undefined;
  } catch (err) {
    logger.error(`Error reading build-profile.json5 at ${projectRoot}: ${String(err)}`);
    return undefined;
  }
}
