import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';
import { OniroError } from '../ports/errors.js';
import { noopLogger, type Logger } from '../ports/logger.js';
import type { ApiEntry, ApiIndex } from './types.js';
import { extractTsDeclarations, resolveComponents, type CallSignatureInfo } from './tsDeclarations.js';
import { addKitFile, emptyKitMap, type KitMap } from './kits.js';
import { extractNativeDeclarations } from './nativeHeaders.js';

/**
 * Build, cache and load the declaration index of one SDK API directory.
 *
 * Sources, relative to the SDK directory:
 * - `ets/api/**` and `ets/arkts/**` (`.d.ts`, `.d.ets`): the `@ohos.*` and `@arkts.*` modules;
 * - `ets/component/**`: the global ArkUI component and decorator declarations;
 * - `ets/kits/@kit.*.d.ts`: which kit re-exports each module symbol (no entries of their own);
 * - `native/sysroot/usr/include/{napi/*.h,node_api*.h,js_native_api*.h}`: Node-API.
 *
 * The index is JSON, cached per SDK directory and rebuilt when the mtime of its
 * `oh-uni-package.json` files (rewritten by an SDK install) or the index format changes.
 */

export const API_INDEX_FORMAT = 1;

type Ts = typeof TS;

export interface BuildApiIndexOptions {
  /**
   * The TypeScript module to parse with. By default the SDK's bundled one
   * (`ets/build-tools/ets-loader/node_modules/typescript`), else one resolvable from here.
   */
  typescript?: unknown;
  logger?: Logger;
}

/** The TypeScript the SDK ships with its ArkTS compiler, else the one installed next to core. */
export function loadTypeScript(sdkDir: string): Ts {
  const loader = path.join(sdkDir, 'ets', 'build-tools', 'ets-loader');
  const candidates: Array<() => unknown> = [
    () => createRequire(path.join(loader, 'package.json'))('typescript'),
    () => createRequire(import.meta.url)('typescript'),
  ];
  for (const load of candidates) {
    try {
      const ts = load() as Ts;
      if (typeof ts?.createSourceFile === 'function') return ts;
    } catch {
      // try the next one
    }
  }
  throw new OniroError(
    `Cannot load TypeScript to parse the SDK declarations: ${path.join(loader, 'node_modules', 'typescript')} ` +
      'is missing and no `typescript` package is installed. Reinstall the SDK (`oniro-app sdk install`).',
  );
}

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, accept, out);
    else if (accept(it.name)) out.push(p);
  }
  return out;
}

const isDecl = (name: string): boolean => name.endsWith('.d.ts') || name.endsWith('.d.ets');

function readPackageInfo(sdkDir: string): { api?: number; version?: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sdkDir, 'ets', 'oh-uni-package.json'), 'utf8')) as {
      apiVersion?: string | number;
      version?: string;
    };
    const api = Number(pkg.apiVersion);
    return { api: Number.isFinite(api) ? api : undefined, version: pkg.version };
  } catch {
    return {};
  }
}

/** What a cached index of `sdkDir` must match to be reused. */
export function apiIndexKey(sdkDir: string): string {
  const parts = [`format=${API_INDEX_FORMAT}`, path.resolve(sdkDir)];
  for (const rel of ['ets/oh-uni-package.json', 'native/oh-uni-package.json']) {
    try {
      parts.push(`${rel}@${fs.statSync(path.join(sdkDir, rel)).mtimeMs}`);
    } catch {
      parts.push(`${rel}@-`);
    }
  }
  return parts.join('|');
}

/** The module name of a declaration file: `@ohos.router`, `@arkts.collections`, `application/UIAbilityContext`. */
function moduleName(relToArea: string): string {
  const noExt = relToArea.replace(/\.d\.e?ts$/, '').split(path.sep).join('/');
  return noExt;
}

const NATIVE_HEADERS = /^(node_api.*|js_native_api.*)\.h$/;

/** Build the index of one SDK API directory (holding `ets/`, and `native/` for Node-API). */
export function buildApiIndex(sdkDir: string, opts: BuildApiIndexOptions = {}): ApiIndex {
  const logger = opts.logger ?? noopLogger;
  const started = Date.now();
  const etsDir = path.join(sdkDir, 'ets');
  if (!fs.existsSync(path.join(etsDir, 'api'))) {
    throw new OniroError(`${sdkDir} is not an SDK API directory: ${path.join(etsDir, 'api')} does not exist.`);
  }
  const ts = (opts.typescript as Ts | undefined) ?? loadTypeScript(sdkDir);
  const rel = (p: string): string => path.relative(sdkDir, p).split(path.sep).join('/');

  const kits: KitMap = emptyKitMap();
  for (const f of walk(path.join(etsDir, 'kits'), (n) => /^@kit\..+\.d\.e?ts$/.test(n))) {
    const kit = path.basename(f).replace(/\.d\.e?ts$/, '');
    addKitFile(ts, kits, kit, fs.readFileSync(f, 'utf8'));
  }

  let entries: ApiEntry[] = [];
  const callable = new Map<string, CallSignatureInfo[]>();
  const candidates: Array<{ entry: ApiEntry; typeName: string }> = [];
  let files = 0;
  const areas: Array<{ dir: string; global: boolean }> = [
    { dir: path.join(etsDir, 'api'), global: false },
    { dir: path.join(etsDir, 'arkts'), global: false },
    { dir: path.join(etsDir, 'component'), global: true },
  ];
  for (const area of areas) {
    for (const f of walk(area.dir, isDecl)) {
      const relArea = path.relative(area.dir, f);
      // `api/@internal` holds the global declarations the ArkUI compiler preloads.
      const global = area.global || relArea.startsWith(`@internal${path.sep}`);
      const module = area.global ? `component/${moduleName(relArea)}` : moduleName(relArea);
      let text: string;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      files++;
      const decl = extractTsDeclarations(ts, text, { relPath: rel(f), module, global });
      applyKits(decl.entries, module, decl.defaultExport, kits);
      for (const [k, v] of decl.callableInterfaces) callable.set(k, [...(callable.get(k) ?? []), ...v]);
      candidates.push(...decl.componentCandidates);
      for (const e of decl.entries) entries.push(e);
    }
  }
  entries = resolveComponents(entries, candidates, callable);

  const include = path.join(sdkDir, 'native', 'sysroot', 'usr', 'include');
  const headers = [
    ...walk(include, (n) => NATIVE_HEADERS.test(n)).filter((f) => path.dirname(f) === include),
    ...walk(path.join(include, 'napi'), (n) => n.endsWith('.h')),
  ];
  for (const h of headers) {
    try {
      const text = fs.readFileSync(h, 'utf8');
      files++;
      const module = path.relative(include, h).split(path.sep).join('/');
      for (const e of extractNativeDeclarations(text, rel(h), module)) entries.push(e);
    } catch {
      // unreadable header: skip
    }
  }

  const info = readPackageInfo(sdkDir);
  const index: ApiIndex = {
    format: API_INDEX_FORMAT,
    sdkDir: path.resolve(sdkDir),
    key: apiIndexKey(sdkDir),
    builtAt: new Date().toISOString(),
    files,
    buildMs: Date.now() - started,
    entries,
  };
  if (info.api !== undefined) index.api = info.api;
  if (info.version) index.sdkVersion = info.version;
  logger.info(`Indexed ${entries.length} declarations from ${files} files in ${index.buildMs} ms.`);
  return index;
}

/** Set `kit` and `import` of a file's entries from the kit re-exports. */
function applyKits(entries: ApiEntry[], module: string, defaultExport: string | undefined, kits: KitMap): void {
  const moduleKit = kits.byModule.get(module);
  for (const e of entries) {
    const top = e.qualifiedName.split('.')[0]!;
    const hit =
      kits.bySymbol.get(`${module}#${top}`) ??
      (defaultExport === top ? kits.bySymbol.get(`${module}#default`) : undefined);
    if (hit) {
      e.kit = hit.kit;
      e.import = `import { ${hit.name} } from '${hit.kit}'`;
      continue;
    }
    if (moduleKit) e.kit = moduleKit;
    if (/^@(ohos|arkts|system)\./.test(module) && !e.global) {
      e.import = defaultExport === top ? `import ${top} from '${module}'` : `import { ${top} } from '${module}'`;
    }
  }
}

/** The cache file of `sdkDir`'s index under `cacheDir`. */
export function apiIndexCachePath(cacheDir: string, sdkDir: string): string {
  const abs = path.resolve(sdkDir);
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12);
  return path.join(cacheDir, 'api-index', `${path.basename(abs)}-${hash}.json`);
}

/** Compact on-disk form: entries as arrays of fields, with repeated strings interned. */
interface StoredIndex extends Omit<ApiIndex, 'entries'> {
  fields: string[];
  strings: string[];
  rows: unknown[][];
}

const STORED_FIELDS: Array<keyof ApiEntry> = [
  'name',
  'qualifiedName',
  'kind',
  'language',
  'module',
  'kit',
  'import',
  'global',
  'since',
  'sinceText',
  'deprecated',
  'deprecatedSince',
  'useInstead',
  'syscap',
  'systemApi',
  'file',
  'line',
  'signature',
  'doc',
];
const INTERNED = new Set<keyof ApiEntry>(['kind', 'language', 'module', 'kit', 'import', 'syscap', 'file', 'deprecated']);

export function serializeApiIndex(index: ApiIndex): string {
  const strings: string[] = [];
  const ids = new Map<string, number>();
  const intern = (s: string): number => {
    let id = ids.get(s);
    if (id === undefined) {
      id = strings.length;
      strings.push(s);
      ids.set(s, id);
    }
    return id;
  };
  const rows = index.entries.map((e) => {
    const row = STORED_FIELDS.map((f) => {
      const v = e[f];
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return INTERNED.has(f) && typeof v === 'string' ? intern(v) : v;
    });
    while (row.length && row[row.length - 1] === null) row.pop();
    return row;
  });
  const { entries: _entries, ...meta } = index;
  const stored: StoredIndex = { ...meta, fields: STORED_FIELDS as string[], strings, rows };
  return JSON.stringify(stored);
}

export function deserializeApiIndex(json: string): ApiIndex {
  const stored = JSON.parse(json) as StoredIndex;
  const fields = stored.fields as Array<keyof ApiEntry>;
  const interned = fields.map((f) => INTERNED.has(f));
  const bools = fields.map((f) => f === 'global' || f === 'systemApi');
  const entries = stored.rows.map((row) => {
    const e: Record<string, unknown> = {};
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      e[fields[i]!] = interned[i] ? stored.strings[v as number] : bools[i] ? v === 1 : v;
    }
    return e as unknown as ApiEntry;
  });
  const { fields: _f, strings: _s, rows: _r, ...meta } = stored;
  return { ...meta, entries };
}

export interface LoadApiIndexOptions extends BuildApiIndexOptions {
  /** Where indexes are cached (an `api-index/` folder is created in it). Omit to not cache. */
  cacheDir?: string;
  /** Rebuild even when the cache is current. */
  rebuild?: boolean;
}

export interface LoadedApiIndex {
  index: ApiIndex;
  /** True when it came from the cache. */
  cached: boolean;
  cachePath?: string;
  /** Wall time to load or build it. */
  loadMs: number;
}

/** The index of `sdkDir`: the cached one when it is current, else a new build (then cached). */
export function loadApiIndex(sdkDir: string, opts: LoadApiIndexOptions = {}): LoadedApiIndex {
  const started = Date.now();
  const logger = opts.logger ?? noopLogger;
  const cachePath = opts.cacheDir ? apiIndexCachePath(opts.cacheDir, sdkDir) : undefined;
  if (cachePath && !opts.rebuild) {
    try {
      const index = deserializeApiIndex(fs.readFileSync(cachePath, 'utf8'));
      if (index.format === API_INDEX_FORMAT && index.key === apiIndexKey(sdkDir)) {
        return { index, cached: true, cachePath, loadMs: Date.now() - started };
      }
      logger.info(`The API index at ${cachePath} is stale; rebuilding.`);
    } catch {
      // no cache yet, or unreadable: build
    }
  }
  logger.info(`Indexing the SDK declarations in ${sdkDir} (once per SDK)...`);
  const index = buildApiIndex(sdkDir, opts);
  if (cachePath) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, serializeApiIndex(index));
      fs.renameSync(tmp, cachePath);
    } catch (err) {
      logger.warn(`Could not cache the API index at ${cachePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { index, cached: false, cachePath, loadMs: Date.now() - started };
}
