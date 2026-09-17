import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';

/**
 * A HarmonyOS SDK install. Unlike the OpenHarmony SDK, which `oniro-app sdk install`
 * downloads, the HarmonyOS SDK only ships inside DevEco Studio or the login-gated
 * HarmonyOS command-line tools, so oniro-app locates an existing install.
 */
export interface HarmonyOsSdk {
  /** The directory containing `default/`; hvigor receives it as `DEVECO_SDK_HOME`. */
  sdkPath: string;
  /** The DevEco Studio or command-line-tools install holding the SDK, its tools and JBR. */
  installRoot: string;
  /** From `default/sdk-pkg.json`, e.g. `HarmonyOS 6.1.1`. */
  displayName?: string;
  /**
   * The release as `compileSdkVersion` names it, e.g. `6.1.1(24)`, from
   * `default/sdk-pkg.json`. hvigor builds only projects that name this release.
   */
  version?: string;
}

/** `displayName` and `version` from `default/sdk-pkg.json`, where it has them. */
function readSdkPkg(sdkPath: string): Pick<HarmonyOsSdk, 'displayName' | 'version'> {
  let data: { displayName?: unknown; platformVersion?: unknown; apiVersion?: unknown } | undefined;
  try {
    data = JSON.parse(fs.readFileSync(path.join(sdkPath, 'default', 'sdk-pkg.json'), 'utf8')).data;
  } catch {
    return {};
  }
  const text = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) || undefined : undefined;
  const platformVersion = text(data?.platformVersion);
  const apiVersion = text(data?.apiVersion);
  return {
    displayName: text(data?.displayName),
    version: platformVersion && apiVersion ? `${platformVersion}(${apiVersion})` : undefined,
  };
}

/**
 * Resolve an install root, or an SDK directory itself, to a HarmonyOS SDK.
 *
 * HarmonyOS and OpenHarmony SDKs share one layout, so an autodetected candidate
 * must also name itself HarmonyOS in `sdk-pkg.json` — otherwise the OpenHarmony
 * command-line tools would pass. An explicitly configured path is taken as given.
 */
function resolveSdk(root: string, requireHarmonyOs: boolean): HarmonyOsSdk | null {
  const nested = path.join(root, 'sdk');
  const sdkPath = [nested, root].find((dir) => fs.existsSync(path.join(dir, 'default', 'openharmony')));
  if (!sdkPath) return null;

  const pkg = readSdkPkg(sdkPath);
  if (requireHarmonyOs && !pkg.displayName?.startsWith('HarmonyOS')) return null;
  return { sdkPath, installRoot: sdkPath === nested ? root : path.dirname(root), ...pkg };
}

/** Where DevEco Studio installs by default. It has no Linux release. */
function studioCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/DevEco-Studio.app/Contents',
      path.join(os.homedir(), 'Applications', 'DevEco-Studio.app', 'Contents'),
    ];
  }
  if (process.platform === 'win32') {
    return [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Huawei', 'DevEco Studio')];
  }
  return [];
}

/**
 * Locate a HarmonyOS SDK, or return null when none is installed.
 *
 * Order: `harmonyosSdkPath` (`ONIRO_HARMONYOS_SDK_PATH`, an install root or its
 * `sdk` directory), then DevEco Studio in its default location, then the
 * command-line tools at `cmdToolsPath` when they are the HarmonyOS edition.
 */
export function findHarmonyOsSdk(opts: { config: ConfigProvider; logger?: Logger }): HarmonyOsSdk | null {
  const logger = opts.logger ?? noopLogger;

  const configured = opts.config.get('harmonyosSdkPath', '');
  if (configured) {
    const sdk = resolveSdk(configured, false);
    if (sdk) return sdk;
    logger.warn(`ONIRO_HARMONYOS_SDK_PATH points at ${configured}, which holds no SDK; ignoring it.`);
  }

  const candidates = [
    ...studioCandidates(),
    opts.config.get('cmdToolsPath', defaultPaths.cmdToolsPath()),
  ];
  for (const candidate of candidates) {
    const sdk = resolveSdk(candidate, true);
    if (sdk) {
      logger.debug(`[harmonyos] Using the ${sdk.displayName} SDK at ${sdk.sdkPath}.`);
      return sdk;
    }
  }
  return null;
}

/** Like `findHarmonyOsSdk`, but throws an actionable error when none is installed. */
export function requireHarmonyOsSdk(opts: { config: ConfigProvider; logger?: Logger }): HarmonyOsSdk {
  const sdk = findHarmonyOsSdk(opts);
  if (sdk) return sdk;
  throw new OniroError(
    'No HarmonyOS SDK found. It ships inside DevEco Studio or the HarmonyOS command-line tools and ' +
      'cannot be downloaded the way the OpenHarmony SDK is. Install one, then set ONIRO_HARMONYOS_SDK_PATH ' +
      'to the install (or its sdk directory).',
  );
}

/**
 * Locate a tool (`hvigorw`, `ohpm`) in a HarmonyOS install: the command-line tools
 * keep them in `bin`, DevEco Studio in `tools/<name>/bin`. Null when absent.
 */
export function findHarmonyOsTool(sdk: HarmonyOsSdk, name: string): string | null {
  const names = process.platform === 'win32' ? [`${name}.bat`, `${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of [path.join(sdk.installRoot, 'bin'), path.join(sdk.installRoot, 'tools', name, 'bin')]) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}
