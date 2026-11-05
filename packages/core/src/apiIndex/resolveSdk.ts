import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultPaths, type ConfigProvider } from '../ports/config.js';
import { OniroError } from '../ports/errors.js';
import { getOhosBaseSdkHome } from '../sdk/paths.js';
import { detectProjectSdkVersion, resolveProjectSdkDir } from '../sdk/detectProjectSdk.js';

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
  /** An API level: `<sdk home>/<api>`. */
  api?: number;
  /** A project directory; its `compileSdkVersion` picks the SDK. Searched upwards for `build-profile.json5`. */
  projectDir?: string;
}

/** The installed OpenHarmony SDK API levels under the SDK home, newest first. */
export function installedApiLevels(config: ConfigProvider): number[] {
  const home = getOhosBaseSdkHome(config);
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d+$/.test(n) && fs.existsSync(path.join(home, n, 'ets', 'api')))
    .map(Number)
    .sort((a, b) => b - a);
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
    const dir = path.join(home, String(opts.api));
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
  const newest = installedApiLevels(config)[0];
  if (newest === undefined) {
    throw new OniroError(
      `${note ? `${note} ` : ''}No OpenHarmony SDK is installed under ${home}. Install one with \`oniro-app sdk install\`.`,
    );
  }
  const selection: ApiSdkSelection = { sdkDir: path.join(home, String(newest)), api: newest, source: 'newest-installed' };
  if (note) selection.note = `${note} Using the newest installed, API ${newest}.`;
  return selection;
}

/** Where API indexes are cached: `<cacheDir>/api-index/` (`cacheDir` defaults to `~/.oniro/cache`). */
export function getApiIndexCacheDir(config: ConfigProvider): string {
  return config.get('cacheDir', defaultPaths.cacheDir());
}
