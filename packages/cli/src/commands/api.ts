import { Command } from 'commander';
import * as path from 'node:path';
import {
  findApiInOtherSdks,
  getApiIndexCacheDir,
  loadApiIndex,
  resolveApiSdk,
  searchApi,
  showApi,
  suggestApiSymbols,
  OniroError,
  type ApiElsewhere,
  type ApiEntry,
  type ApiIndex,
  type ApiSdkSelection,
  type ApiSearchHit,
  type ApiSymbolKind,
  type LoadedApiIndex,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface SdkOpts {
  api?: string;
  sdk?: string;
  project?: string;
  rebuild?: boolean;
  json?: boolean;
}

interface SearchOpts extends SdkOpts {
  kit?: string;
  kind?: string[];
  lang?: string;
  limit?: string;
  deprecated?: boolean;
  systemapi?: boolean;
}

interface ShowOpts extends SdkOpts {
  kit?: string;
  otherSdks?: boolean;
}

const KINDS: readonly ApiSymbolKind[] = [
  'namespace',
  'class',
  'interface',
  'enum',
  'enumMember',
  'type',
  'function',
  'method',
  'constructor',
  'property',
  'variable',
  'component',
  'decorator',
  'macro',
  'typedef',
  'struct',
];

function parseApi(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new OniroError(`--api expects an API level such as 20, got "${value}".`);
  return n;
}

function parseKinds(values: string[] | undefined): ApiSymbolKind[] | undefined {
  if (!values?.length) return undefined;
  const out: ApiSymbolKind[] = [];
  for (const v of values.flatMap((x) => x.split(','))) {
    const k = KINDS.find((kind) => kind.toLowerCase() === v.trim().toLowerCase());
    if (!k) throw new OniroError(`Unknown --kind "${v}". Kinds: ${KINDS.join(', ')}.`);
    out.push(k);
  }
  return out;
}

function selectSdk(opts: SdkOpts): ApiSdkSelection {
  const { config, logger } = getRuntime();
  const selection = resolveApiSdk(config, {
    sdkDir: opts.sdk,
    api: parseApi(opts.api),
    projectDir: opts.project ? path.resolve(opts.project) : process.cwd(),
  });
  if (selection.note) logger.warn(selection.note);
  return selection;
}

function openIndex(sdkDir: string, rebuild?: boolean): LoadedApiIndex {
  const { config, logger } = getRuntime();
  return loadApiIndex(sdkDir, { cacheDir: getApiIndexCacheDir(config), rebuild, logger });
}

/** `API 20 (6.0.0.47)`. */
export function describeIndex(index: Pick<ApiIndex, 'api' | 'sdkVersion' | 'sdkDir'>): string {
  const api = index.api !== undefined ? `API ${index.api}` : index.sdkDir;
  return index.sdkVersion ? `${api} (${index.sdkVersion})` : api;
}

/** The facts line of an entry: `method  @kit.ArkUI  since 10  deprecated since 18, use X  systemapi`. */
export function apiEntryFacts(e: ApiEntry): string {
  const parts: string[] = [e.kind];
  if (e.kit) parts.push(e.kit);
  if (e.since !== undefined) parts.push(`since ${e.sinceText ?? e.since}`);
  if (e.deprecated !== undefined) {
    const dep = e.deprecated ? `deprecated ${e.deprecated}` : 'deprecated';
    parts.push(e.useInstead ? `${dep}, use ${e.useInstead}` : dep);
  }
  if (e.systemApi) parts.push('systemapi');
  return parts.join('  ');
}

/** One hit or entry as text: name and facts, the signature, the doc line, then where. */
export function formatApiEntry(e: ApiEntry & { overloads?: number }, sdkDir: string): string {
  const lines = [`${e.qualifiedName}  ${apiEntryFacts(e)}`];
  lines.push(`  ${e.signature}${e.overloads ? `   (+${e.overloads} overload${e.overloads > 1 ? 's' : ''})` : ''}`);
  if (e.doc) lines.push(`  ${e.doc}`);
  const where = [`${path.join(sdkDir, e.file)}:${e.line}`, e.module];
  if (e.import) where.push(e.import);
  else if (e.global) where.push('global, no import');
  if (e.syscap) where.push(e.syscap);
  lines.push(`  ${where.join('  ')}`);
  return lines.join('\n');
}

/** An entry for `--json`: the fields as indexed, plus the absolute `path`. */
function jsonEntry<T extends ApiEntry>(e: T, sdkDir: string): T & { path: string } {
  return { ...e, path: path.join(sdkDir, e.file) };
}

export function registerApiCommand(program: Command): void {
  const api = program
    .command('api')
    .description(
      "Look up the SDK's declarations: the ArkTS API (`ets/api`, `ets/arkts`, the ArkUI components in `ets/component`, " +
        'with the kit that exports each symbol) and the Node-API C headers, at one API level. The index is built on first ' +
        'use (a few seconds) and cached under ~/.oniro/cache (ONIRO_CACHE_DIR).',
    );

  const sdkOptions = (cmd: Command): Command =>
    cmd
      .option(
        '--api <level>',
        "The SDK API level to read. Default: the project's compileSdkVersion (from the current directory or " +
          '--project), else the newest installed SDK.',
      )
      .option('--sdk <dir>', 'An SDK API directory (holding ets/) to read instead.')
      .option('--project <dir>', 'The project whose compileSdkVersion picks the SDK (default: the current directory).')
      .option('--rebuild', 'Rebuild the index even if the cached one is current.');

  sdkOptions(
    api
      .command('search <query...>')
      .description(
        'Ranked search: every word must match a symbol name (exact name > prefix > camelCase part > substring) or its ' +
          'doc line. A dotted word matches qualified names (`router.pushUrl`); a leading @ is ignored (`@Local`).',
      ),
  )
    .option('--kit <name>', 'Only symbols this kit exports (`ArkUI` or `@kit.ArkUI`).')
    .option('--kind <kinds...>', `Only these kinds: ${KINDS.join(', ')}.`)
    .option('--lang <lang>', 'Only `arkts` declarations or `c` (Node-API headers).')
    .option('--limit <n>', 'At most n hits.', '20')
    .option('--no-deprecated', 'Leave out @deprecated symbols.')
    .option('--no-systemapi', 'Leave out @systemapi symbols (system apps only).')
    .option(
      '--json',
      'Print JSON: sdk (dir, api, version, source), query, total, hits (name, qualifiedName, kind, kit, import, module, ' +
        'since, deprecated, deprecatedSince, useInstead, syscap, systemApi, file, path, line, signature, doc, overloads, score).',
    )
    .action((words: string[], opts: SearchOpts) => {
      const query = words.join(' ');
      const sel = selectSdk(opts);
      const { index } = openIndex(sel.sdkDir, opts.rebuild);
      const lang = opts.lang?.toLowerCase();
      if (lang && lang !== 'arkts' && lang !== 'c') throw new OniroError(`--lang expects arkts or c, got "${opts.lang}".`);
      const limit = Number(opts.limit ?? 20);
      if (!Number.isInteger(limit) || limit <= 0) throw new OniroError(`--limit expects a positive number, got "${opts.limit}".`);
      const result = searchApi(index, query, {
        kit: opts.kit,
        kinds: parseKinds(opts.kind),
        language: lang as 'arkts' | 'c' | undefined,
        noDeprecated: opts.deprecated === false,
        noSystemApi: opts.systemapi === false,
        limit,
      });
      if (opts.json) {
        const out = {
          sdk: { dir: index.sdkDir, api: index.api, version: index.sdkVersion, source: sel.source },
          query: result.query,
          total: result.total,
          hits: result.hits.map((h: ApiSearchHit) => jsonEntry(h, index.sdkDir)),
        };
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      } else {
        for (const h of result.hits) process.stdout.write(`${formatApiEntry(h, index.sdkDir)}\n\n`);
        const shown = result.hits.length < result.total ? `${result.hits.length} of ${result.total}` : `${result.total}`;
        process.stdout.write(`${shown} match${result.total === 1 ? '' : 'es'} in ${describeIndex(index)}.\n`);
      }
      process.exitCode = result.total ? 0 : 1;
    });

  sdkOptions(
    api
      .command('show <symbol>')
      .description(
        'Exact lookup: is `symbol` declared at this API level? Takes a qualified name (`NavPathStack.pushPathByName`, ' +
          '`router.pushUrl`, `Column`, `@Local`, `napi_create_threadsafe_function`); when none matches, names that end ' +
          'with it (`Preferences.get`). Prints every declaration (overloads included). Exits 1 when it is not declared, ' +
          'naming the other installed SDKs that declare it and close matches.',
      ),
  )
    .option('--kit <name>', 'Only declarations this kit exports.')
    .option('--no-other-sdks', 'On a miss, do not look in the other installed SDKs.')
    .option(
      '--json',
      'Print JSON: sdk, symbol, found, entries (the `search` hit fields), and on a miss alsoIn ([{api, since}]) and ' +
        'suggestions (qualified names).',
    )
    .action((symbol: string, opts: ShowOpts) => {
      const sel = selectSdk(opts);
      const { index } = openIndex(sel.sdkDir, opts.rebuild);
      const r = showApi(index, symbol, { kit: opts.kit });
      let alsoIn: ApiElsewhere[] = [];
      let suggestions: string[] = [];
      if (!r.found) {
        const { config, logger } = getRuntime();
        if (opts.otherSdks !== false) {
          alsoIn = findApiInOtherSdks(config, symbol, index.sdkDir, {
            cacheDir: getApiIndexCacheDir(config),
            kit: opts.kit,
            logger,
          });
        }
        suggestions = suggestApiSymbols(index, symbol);
      }
      if (opts.json) {
        const out: Record<string, unknown> = {
          sdk: { dir: index.sdkDir, api: index.api, version: index.sdkVersion, source: sel.source },
          symbol,
          found: r.found,
          entries: r.entries.map((e) => jsonEntry(e, index.sdkDir)),
        };
        if (!r.found) {
          out.alsoIn = alsoIn;
          out.suggestions = suggestions;
        }
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      } else if (r.found) {
        for (const e of r.entries) process.stdout.write(`${formatApiEntry(e, index.sdkDir)}\n\n`);
        process.stdout.write(
          `${symbol} is declared in ${describeIndex(index)} (${r.entries.length} declaration${r.entries.length === 1 ? '' : 's'}).\n`,
        );
      } else {
        process.stdout.write(`${symbol} is not declared in ${describeIndex(index)}.\n`);
        for (const a of alsoIn) {
          process.stdout.write(`  declared in the installed API ${a.api} SDK${a.since !== undefined ? ` (@since ${a.since})` : ''}\n`);
        }
        if (suggestions.length) process.stdout.write(`  close matches: ${suggestions.join(', ')}\n`);
      }
      process.exitCode = r.found ? 0 : 1;
    });

  sdkOptions(
    api.command('index').description('Build (or refresh) the index of one SDK and print its size, for warming a cache.'),
  )
    .option('--json', 'Print JSON: sdk, entries, files, buildMs, cached, cachePath, loadMs.')
    .action((opts: SdkOpts) => {
      const sel = selectSdk(opts);
      const loaded = openIndex(sel.sdkDir, opts.rebuild);
      const { index } = loaded;
      if (opts.json) {
        const out = {
          sdk: { dir: index.sdkDir, api: index.api, version: index.sdkVersion, source: sel.source },
          entries: index.entries.length,
          files: index.files,
          buildMs: index.buildMs,
          builtAt: index.builtAt,
          cached: loaded.cached,
          cachePath: loaded.cachePath,
          loadMs: loaded.loadMs,
        };
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      } else {
        process.stdout.write(
          `${describeIndex(index)}: ${index.entries.length} declarations from ${index.files} files, ` +
            `${loaded.cached ? `cached (built ${index.builtAt})` : `built in ${index.buildMs} ms`}, ${loaded.cachePath}\n`,
        );
      }
    });
}
