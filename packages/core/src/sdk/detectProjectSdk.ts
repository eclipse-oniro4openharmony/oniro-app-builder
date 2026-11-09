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
 * `productName` picks the product as {@link detectProjectSdkVersion} does.
 */
export function findMissingProjectSdk(
  config: ConfigProvider,
  projectRoot: string,
  productName?: string,
): SdkNotInstalledError | null {
  const api = detectProjectSdkVersion(projectRoot, noopLogger, productName);
  if (api === undefined) return null;
  if (resolveProjectSdkDir(config, projectRoot, productName)) return null;
  const expected = path.join(getOhosBaseSdkHome(config), String(api));
  return new SdkNotInstalledError(String(api), expected, ALL_SDKS.find((s) => s.api === String(api))?.version);
}

/**
 * The SDK API directory an OpenHarmony project builds against, as hvigor finds it:
 * `<sdk home>/<compileSdkVersion>`, else under the project's `local.properties`
 * `sdk.dir`. Undefined when neither holds it or the project names no numeric API.
 * `productName` picks the product as {@link detectProjectSdkVersion} does.
 */
export function resolveProjectSdkDir(
  config: ConfigProvider,
  projectRoot: string,
  productName?: string,
): string | undefined {
  const api = detectProjectSdkVersion(projectRoot, noopLogger, productName);
  if (api === undefined) return undefined;
  const expected = path.join(getOhosBaseSdkHome(config), String(api));
  if (fs.existsSync(expected)) return expected;
  const localSdkDir = localPropertiesSdkDir(projectRoot);
  const local = localSdkDir ? path.join(localSdkDir, String(api)) : undefined;
  return local && fs.existsSync(local) ? local : undefined;
}

/**
 * Detect the SDK API a project targets by reading `build-profile.json5`.
 * Returns the `compileSdkVersion` of the product named `productName`, else of
 * the first declared product (as `detectRuntimeOs` picks it), or undefined if
 * the file is missing/malformed or that product declares none. A project that
 * also targets HarmonyOS often lists its HarmonyOS product first, with no
 * numeric `compileSdkVersion`, so callers that know the product pass it.
 */
export function detectProjectSdkVersion(
  projectRoot: string,
  logger: Logger = noopLogger,
  productName?: string,
): number | undefined {
  const buildProfilePath = path.join(projectRoot, 'build-profile.json5');
  if (!fs.existsSync(buildProfilePath)) {
    logger.warn(`build-profile.json5 not found at ${projectRoot}`);
    return undefined;
  }
  try {
    const content = fs.readFileSync(buildProfilePath, 'utf-8');
    const config = JSON5.parse(content) as {
      app?: { products?: Array<{ name?: unknown; compileSdkVersion?: unknown }> };
    };
    const products = Array.isArray(config.app?.products) ? config.app.products : [];
    const product = (productName !== undefined && products.find((p) => p.name === productName)) || products[0];
    const v = product?.compileSdkVersion;
    return typeof v === 'number' ? v : undefined;
  } catch (err) {
    logger.error(`Error reading build-profile.json5 at ${projectRoot}: ${String(err)}`);
    return undefined;
  }
}
