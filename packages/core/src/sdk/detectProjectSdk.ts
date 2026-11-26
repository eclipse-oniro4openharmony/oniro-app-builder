import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import { Logger, noopLogger } from '../ports/logger.js';
import type { ConfigProvider } from '../ports/config.js';
import { SdkNotInstalledError } from '../ports/errors.js';
import { ALL_SDKS } from './constants.js';
import { getOhosBaseSdkHome } from './paths.js';
import { localPropertiesSdkDir } from './localProperties.js';
import { apiOfDottedVersion, usesDottedVersion } from './apiVersion.js';
import { expectedSdkApiDir, findSdkApiDir, migrateLegacySdkApiDir, type SdkApiDir } from './apiDir.js';

/**
 * The OpenHarmony SDK an OpenHarmony project builds against is missing, as a typed
 * error naming the release to install, or null when it is installed or the project
 * declares no OpenHarmony `compileSdkVersion`. hvigor looks for it in the SDK home
 * (`OHOS_BASE_SDK_HOME`, else the project's `local.properties` `sdk.dir`), under
 * `<compileSdkVersion>` (see `sdk/apiDir.ts`), and otherwise fails late with
 * `00308018 SDK path does not exist` / "SDK license agreement is not accepted".
 * `productName` picks the product as {@link detectProjectSdkVersion} does.
 */
export function findMissingProjectSdk(
  config: ConfigProvider,
  projectRoot: string,
  productName?: string,
): SdkNotInstalledError | null {
  const sdk = detectProjectSdk(projectRoot, noopLogger, productName);
  if (sdk === undefined) return null;
  if (findProjectSdkDir(config, projectRoot, productName)) return null;
  const expected = expectedSdkApiDir(getOhosBaseSdkHome(config), sdk.api, sdk.declared);
  return new SdkNotInstalledError(String(sdk.api), expected, ALL_SDKS.find((s) => s.api === String(sdk.api))?.version);
}

/**
 * The SDK API directory an OpenHarmony project builds against, as hvigor finds it:
 * in the SDK home, else under the project's `local.properties` `sdk.dir`. Undefined
 * when neither holds it or the project names no OpenHarmony SDK. `productName` picks
 * the product as {@link detectProjectSdkVersion} does.
 */
export function resolveProjectSdkDir(
  config: ConfigProvider,
  projectRoot: string,
  productName?: string,
): string | undefined {
  return findProjectSdkDir(config, projectRoot, productName)?.dir;
}

/**
 * Like {@link resolveProjectSdkDir}, with whether the SDK is in a legacy folder
 * (`<sdk home>/26`) that hvigor 6.26 does not read; {@link migrateProjectSdkDir} moves it.
 */
export function findProjectSdkDir(
  config: ConfigProvider,
  projectRoot: string,
  productName?: string,
): SdkApiDir | undefined {
  const sdk = detectProjectSdk(projectRoot, noopLogger, productName);
  if (sdk === undefined) return undefined;
  const found = findSdkApiDir(getOhosBaseSdkHome(config), sdk.api, sdk.declared);
  if (found) return found;
  const localSdkDir = localPropertiesSdkDir(projectRoot);
  return localSdkDir ? findSdkApiDir(localSdkDir, sdk.api, sdk.declared) : undefined;
}

/**
 * Move the SDK an OpenHarmony project compiles with from the legacy `<sdk home>/<api>`
 * folder to the one hvigor 6.26 reads (`<sdk home>/26.0.0`), for API 26 and later.
 * Only the oniro-app SDK home is touched, not a `local.properties` one. Returns the
 * new folder, or undefined when nothing moved.
 */
export function migrateProjectSdkDir(
  config: ConfigProvider,
  projectRoot: string,
  productName?: string,
  logger: Logger = noopLogger,
): string | undefined {
  const sdk = detectProjectSdk(projectRoot, noopLogger, productName);
  if (sdk === undefined || !usesDottedVersion(sdk.api)) return undefined;
  const home = getOhosBaseSdkHome(config);
  if (!findSdkApiDir(home, sdk.api, sdk.declared)?.legacy) return undefined;
  return migrateLegacySdkApiDir(home, sdk.api, { ...(sdk.declared ? { declared: sdk.declared } : {}), logger });
}

/** The OpenHarmony SDK a product declares. */
export interface ProjectSdk {
  /** The API level. */
  api: number;
  /** The dotted release it names, from API 26 (`26.0.0`); hvigor needs that exact one. */
  declared?: string;
}

/**
 * Detect the SDK API a project targets by reading `build-profile.json5`.
 * Returns the `compileSdkVersion` of the product named `productName`, else of
 * the first declared product (as `detectRuntimeOs` picks it), or undefined if
 * the file is missing/malformed or that product declares no OpenHarmony SDK: a
 * number, or from API 26 a dotted release (`"26.0.0"`). A project that also targets
 * HarmonyOS often lists its HarmonyOS product first, whose `compileSdkVersion` names
 * a HarmonyOS release and is not read, so callers that know the product pass it.
 */
export function detectProjectSdkVersion(
  projectRoot: string,
  logger: Logger = noopLogger,
  productName?: string,
): number | undefined {
  return detectProjectSdk(projectRoot, logger, productName)?.api;
}

/** Like {@link detectProjectSdkVersion}, with the dotted release a product names from API 26. */
export function detectProjectSdk(
  projectRoot: string,
  logger: Logger = noopLogger,
  productName?: string,
): ProjectSdk | undefined {
  const buildProfilePath = path.join(projectRoot, 'build-profile.json5');
  if (!fs.existsSync(buildProfilePath)) {
    logger.warn(`build-profile.json5 not found at ${projectRoot}`);
    return undefined;
  }
  try {
    const content = fs.readFileSync(buildProfilePath, 'utf-8');
    const config = JSON5.parse(content) as {
      app?: { products?: Array<{ name?: unknown; compileSdkVersion?: unknown; runtimeOS?: unknown }> };
    };
    const products = Array.isArray(config.app?.products) ? config.app.products : [];
    const product = (productName !== undefined && products.find((p) => p.name === productName)) || products[0];
    const v = product?.compileSdkVersion;
    if (typeof v === 'number') return { api: v };
    if (typeof v === 'string' && product?.runtimeOS !== 'HarmonyOS') {
      const api = apiOfDottedVersion(v);
      if (api !== undefined) return { api, declared: v.trim() };
    }
    return undefined;
  } catch (err) {
    logger.error(`Error reading build-profile.json5 at ${projectRoot}: ${String(err)}`);
    return undefined;
  }
}
