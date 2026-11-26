import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { apiOfDottedVersion, compareDottedVersions, dottedVersionFor, usesDottedVersion } from './apiVersion.js';

/**
 * Where an OpenHarmony SDK lives in the SDK home (`<sdkRootDir>/<os>`), as hvigor
 * looks it up: one folder per SDK, named by the API level up to API 25 (`20/`) and by
 * the components' dotted release from API 26 (`26.0.0/`). hvigor 6.26 skips an API 26
 * SDK in `26/`, where oniro-app installed it before, and fails with "The SDK
 * management mode has changed"; {@link migrateLegacySdkApiDir} moves it. It also skips
 * a symlinked API 26+ folder, so such a link does not count as an install here.
 */

/** What an OpenHarmony SDK API folder says about itself, from a component's `oh-uni-package.json`. */
export interface OhUniPackageInfo {
  /** e.g. `26`. */
  apiVersion?: string;
  /** The dotted release, e.g. `26.0.0`. Older SDKs name their own (`5.0.0`), which is not their folder name. */
  platformVersion?: string;
  /** The SDK build, e.g. `26.0.0.39`. */
  version?: string;
}

/** {@link OhUniPackageInfo} of the SDK whose components are in `apiDir`; empty when none can be read. */
export function readOhUniPackage(apiDir: string): OhUniPackageInfo {
  for (const component of ['ets', 'toolchains', 'js', 'native', 'previewer']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(apiDir, component, 'oh-uni-package.json'), 'utf8')) as {
        apiVersion?: unknown;
        platformVersion?: unknown;
        version?: unknown;
      };
      const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) || undefined : undefined);
      const info: OhUniPackageInfo = {};
      const apiVersion = text(pkg.apiVersion);
      const platformVersion = text(pkg.platformVersion);
      const version = text(pkg.version);
      if (apiVersion) info.apiVersion = apiVersion;
      if (platformVersion) info.platformVersion = platformVersion;
      if (version) info.version = version;
      return info;
    } catch {
      // Try the next component.
    }
  }
  return {};
}

/**
 * The folder name hvigor looks for the SDK of `api` under: the API level up to 25,
 * the dotted release from 26 (`platformVersion` when it is one, else `<api>.0.0`).
 */
export function sdkApiDirName(api: number | string, platformVersion?: string): string {
  return usesDottedVersion(api) ? dottedVersionFor(Number(api), platformVersion) : String(api);
}

/** The API level an SDK home entry is for (`20` → 20, `26.0.0` → 26, also a legacy `26`), or undefined. */
export function apiOfSdkDirName(name: string): number | undefined {
  if (/^\d+$/.test(name)) return Number(name);
  return apiOfDottedVersion(name);
}

/** An installed OpenHarmony SDK API folder. */
export interface SdkApiDir {
  api: number;
  dir: string;
  /**
   * An API 26+ SDK in `<home>/<api>`, where oniro-app installed it before. hvigor
   * 6.26 does not find it there; {@link migrateLegacySdkApiDir} moves it.
   */
  legacy: boolean;
}

/**
 * Every SDK API folder in `home`, newest API first; for one API, the folders hvigor
 * finds (newest release first) before a legacy one. Empty when `home` is unreadable.
 */
export function listSdkApiDirs(home: string): SdkApiDir[] {
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  const dirs: SdkApiDir[] = [];
  for (const name of names) {
    const api = apiOfSdkDirName(name);
    if (api === undefined) continue;
    const dir = path.join(home, name);
    const dotted = usesDottedVersion(api);
    let isDir = false;
    try {
      // hvigor 6.26 does not look into a symlinked API 26+ folder; older ones follow links.
      isDir = (dotted ? fs.lstatSync(dir) : fs.statSync(dir)).isDirectory();
    } catch {
      // A dangling link or an unreadable entry.
    }
    if (isDir) dirs.push({ api, dir, legacy: dotted && /^\d+$/.test(name) });
  }
  return dirs.sort(
    (a, b) =>
      b.api - a.api ||
      Number(a.legacy) - Number(b.legacy) ||
      compareDottedVersions(path.basename(b.dir), path.basename(a.dir)),
  );
}

/**
 * The installed SDK for `api` in `home`, or undefined. `declared`, a project's dotted
 * `compileSdkVersion` (`26.0.1`), asks for that release only, as hvigor does: its own
 * folder, else a legacy folder holding it. Otherwise the first of {@link listSdkApiDirs}
 * for `api`, which is legacy only when nothing else holds that API.
 */
export function findSdkApiDir(home: string, api: number | string, declared?: string): SdkApiDir | undefined {
  const forApi = listSdkApiDirs(home).filter((d) => d.api === Number(api));
  const release = declared?.trim();
  if (release !== undefined && apiOfDottedVersion(release) !== undefined) {
    return (
      forApi.find((d) => !d.legacy && path.basename(d.dir) === release) ??
      forApi.find((d) => d.legacy && (readOhUniPackage(d.dir).platformVersion ?? release) === release)
    );
  }
  return forApi[0];
}

/** Where the SDK for `api` belongs in `home`: `declared` (a dotted release) names the folder, else {@link sdkApiDirName}. */
export function expectedSdkApiDir(home: string, api: number | string, declared?: string): string {
  const release = declared?.trim();
  const name = release !== undefined && apiOfDottedVersion(release) === Number(api) ? release : sdkApiDirName(api);
  return path.join(home, name);
}

/**
 * Where {@link migrateLegacySdkApiDir} moves the legacy `<home>/<api>` folder: the
 * release its components name, else `declared` (a project's dotted `compileSdkVersion`
 * for that API, which {@link findSdkApiDir} matched it to), else `<api>.0.0`.
 */
export function legacySdkApiDirTarget(home: string, api: number | string, declared?: string): string {
  const release = [readOhUniPackage(path.join(home, String(api))).platformVersion, declared?.trim()].find(
    (v) => v !== undefined && apiOfDottedVersion(v) === Number(api),
  );
  return path.join(home, sdkApiDirName(api, release));
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Move an API 26+ SDK from `<home>/<api>`, where oniro-app installed it before, to
 * `<home>/<release>` ({@link legacySdkApiDirTarget}), where hvigor 6.26 looks. A link
 * there to the legacy folder, which hvigor does not follow, is replaced. Returns where
 * the SDK is now, or undefined when there is no legacy folder for `api` or the target
 * is otherwise taken (both are then left as they are).
 */
export function migrateLegacySdkApiDir(
  home: string,
  api: number | string,
  opts: { declared?: string; logger?: Logger } = {},
): string | undefined {
  const logger = opts.logger ?? noopLogger;
  if (!usesDottedVersion(api)) return undefined;
  const legacy = path.join(home, String(api));
  if (!listSdkApiDirs(home).some((d) => d.legacy && d.dir === legacy)) return undefined;
  const target = legacySdkApiDirTarget(home, api, opts.declared);
  if (isSymlink(target)) {
    let linksToLegacy = false;
    try {
      linksToLegacy = fs.realpathSync(target) === fs.realpathSync(legacy);
    } catch {
      // A dangling link.
    }
    if (!linksToLegacy) return undefined;
    try {
      fs.unlinkSync(target);
    } catch {
      fs.rmdirSync(target); // A directory link on Windows.
    }
    logger.info(`Removed ${target}, a link to ${legacy} that hvigor 6.26 does not follow.`);
  } else if (fs.existsSync(target)) {
    return undefined;
  }
  fs.renameSync(legacy, target);
  logger.info(`Moved the API ${api} SDK from ${legacy} to ${target}, where hvigor 6.26 and later look for it.`);
  return target;
}
