import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultPaths, type ConfigProvider } from '../ports/config.js';
import { OniroError } from '../ports/errors.js';
import { getOhosBaseSdkHome } from '../sdk/paths.js';
import { detectProjectSdkVersion, resolveProjectSdkDir } from '../sdk/detectProjectSdk.js';
import { expectedSdkApiDir, findSdkApiDir, listSdkApiDirs, type SdkApiDir } from '../sdk/apiDir.js';

/** Which SDK API directory `api search` and `api show` read, and why. */
export interface ApiSdkSelection {
  sdkDir: string;
  api?: number;
  source: 'sdk-option' | 'api-option' | 'project' | 'newest-installed';
  /** Why the SDK is not the one the project asks for, when it is not. */
  note?: string;
}

export interface ResolveApiSdkOptions {
  /** An SDK API directory (holding `ets/`), used as is. */
  sdkDir?: string;
  /** An API level: its folder in the SDK home (`<api>`, or from API 26 `<release>`). */
  api?: number;
  /** A project directory; its `compileSdkVersion` picks the SDK. Searched upwards for `build-profile.json5`. */
  projectDir?: string;
}

/** The installed OpenHarmony SDK API levels under the SDK home, newest first. */
export function installedApiLevels(config: ConfigProvider): number[] {
  return installedApiDirs(config).map((d) => d.api);
}

/** One SDK folder with declarations (`ets/api`) per installed API level, newest first. */
function installedApiDirs(config: ConfigProvider): SdkApiDir[] {
  const seen = new Set<number>();
  return listSdkApiDirs(getOhosBaseSdkHome(config)).filter((d) => {
    if (seen.has(d.api) || !fs.existsSync(path.join(d.dir, 'ets', 'api'))) return false;
    seen.add(d.api);
    return true;
  });
}

/**
 * The nearest directory at or above `dir` whose `build-profile.json5` names a
 * `compileSdkVersion` (the project root, not a module's).
 */
function findProjectRoot(dir: string): string | undefined {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, 'build-profile.json5')) && detectProjectSdkVersion(cur) !== undefined) {
      return cur;
    }
    const up = path.dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

/**
 * Pick the SDK: `sdkDir`, else `<sdk home>/<api>`, else the one the enclosing
 * project's `compileSdkVersion` names (as hvigor finds it), else the newest installed.
 */
export function resolveApiSdk(config: ConfigProvider, opts: ResolveApiSdkOptions = {}): ApiSdkSelection {
  if (opts.sdkDir) {
    const dir = path.resolve(opts.sdkDir);
    if (!fs.existsSync(path.join(dir, 'ets', 'api'))) {
      throw new OniroError(`${dir} is not an SDK API directory (no ets/api in it).`);
    }
    return { sdkDir: dir, source: 'sdk-option' };
  }
  const home = getOhosBaseSdkHome(config);
  if (opts.api !== undefined) {
    const dir =
      installedApiDirs(config).find((d) => d.api === Number(opts.api))?.dir ??
      findSdkApiDir(home, opts.api)?.dir ??
      expectedSdkApiDir(home, opts.api);
    if (!fs.existsSync(path.join(dir, 'ets', 'api'))) {
      const installed = installedApiLevels(config);
      throw new OniroError(
        `The API ${opts.api} SDK is not installed at ${dir}` +
          (installed.length ? ` (installed: ${installed.join(', ')}).` : '.') +
          ` Install it with \`oniro-app sdk install ${opts.api}\`.`,
      );
    }
    return { sdkDir: dir, api: opts.api, source: 'api-option' };
  }
  const root = opts.projectDir ? findProjectRoot(opts.projectDir) : undefined;
  let note: string | undefined;
  if (root) {
    const dir = resolveProjectSdkDir(config, root);
    const api = detectProjectSdkVersion(root);
    if (dir) return { sdkDir: dir, api, source: 'project' };
    note = `The project at ${root} compiles with API ${api}, whose SDK is not installed.`;
  }
  const newestDir = installedApiDirs(config)[0];
  const newest = newestDir?.api;
  if (newestDir === undefined || newest === undefined) {
    throw new OniroError(
      `${note ? `${note} ` : ''}No OpenHarmony SDK is installed under ${home}. Install one with \`oniro-app sdk install\`.`,
    );
  }
  const selection: ApiSdkSelection = { sdkDir: newestDir.dir, api: newest, source: 'newest-installed' };
  if (note) selection.note = `${note} Using the newest installed, API ${newest}.`;
  return selection;
}

/** Where API indexes are cached: `<cacheDir>/api-index/` (`cacheDir` defaults to `~/.oniro/cache`). */
export function getApiIndexCacheDir(config: ConfigProvider): string {
  return config.get('cacheDir', defaultPaths.cacheDir());
}
