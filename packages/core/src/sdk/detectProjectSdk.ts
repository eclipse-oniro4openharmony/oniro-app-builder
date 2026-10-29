import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import { Logger, noopLogger } from '../ports/logger.js';
import type { ConfigProvider } from '../ports/config.js';
import { SdkNotInstalledError } from '../ports/errors.js';
import { ALL_SDKS } from './constants.js';
import { getOhosBaseSdkHome } from './paths.js';

/**
 * The `sdk.dir` a project's `local.properties` names (a base SDK home holding API
 * folders, as `createScaffold` writes it), unescaped, or undefined.
 */
function localPropertiesSdkDir(projectRoot: string): string | undefined {
  try {
    const content = fs.readFileSync(path.join(projectRoot, 'local.properties'), 'utf-8');
    const m = /^\s*sdk\.dir\s*[=:]\s*(.+?)\s*$/m.exec(content);
    return m ? m[1]!.replace(/\\(.)/g, '$1') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The OpenHarmony SDK an OpenHarmony project builds against is missing, as a typed
 * error naming the release to install, or null when it is installed or the project
 * declares no numeric `compileSdkVersion`. hvigor looks for
 * `<sdk home>/<compileSdkVersion>`, the home being `OHOS_BASE_SDK_HOME` or the
 * project's `local.properties` `sdk.dir`, and otherwise fails late with
 * `00308018 SDK path does not exist` / "SDK license agreement is not accepted".
 */
export function findMissingProjectSdk(config: ConfigProvider, projectRoot: string): SdkNotInstalledError | null {
  const api = detectProjectSdkVersion(projectRoot);
  if (api === undefined) return null;
  const expected = path.join(getOhosBaseSdkHome(config), String(api));
  if (fs.existsSync(expected)) return null;
  const localSdkDir = localPropertiesSdkDir(projectRoot);
  if (localSdkDir && fs.existsSync(path.join(localSdkDir, String(api)))) return null;
  return new SdkNotInstalledError(String(api), expected, ALL_SDKS.find((s) => s.api === String(api))?.version);
}

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
