import { Command } from 'commander';
import {
  DocsIndex,
  docsDirFor,
  docsRefFor,
  docsTree,
  getDocsRootDir,
  readSdkRelease,
  syncDocs,
  OniroError,
  type DocSearchHit,
  type DocSearchResult,
  type DocShowResult,
  type SyncDocsResult,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { selectSdk, type SdkOpts } from './api.js';
import type { ApiSdkSelection } from '@oniroproject/core';

export interface DocsOpts extends Pick<SdkOpts, 'api' | 'sdk' | 'project'> {
  /** The docs branch or tag, instead of the one the SDK's version names. */
  ref?: string;
  json?: boolean;
}

export interface DocsSearchOpts extends DocsOpts {
  limit?: string;
  section?: string;
}

export interface DocsShowOpts extends DocsOpts {
  heading?: string;
  lines?: string;
}

/** Which release's docs: `--ref`, else the branch the selected SDK's version names. */
export interface DocsSelection {
  ref: string;
  dir: string;
  /** The SDK whose version chose the ref (none with `--ref`; only `api` when that SDK is not installed). */
  sdk?: { dir?: string; api?: number; version?: string };
}

export function selectDocs(opts: DocsOpts): DocsSelection {
  const { config, logger } = getRuntime();
  if (opts.ref) return { ref: opts.ref, dir: docsDirFor(config, opts.ref) };
  const api = opts.api !== undefined ? Number(opts.api) : undefined;
  let sel: ApiSdkSelection;
  try {
    sel = selectSdk(opts);
  } catch (err) {
    // The docs of an API level do not need its SDK: fall back to the level's known release.
    if (api === undefined || !Number.isInteger(api) || api <= 0) throw err;
    const ref = docsRefFor({ api });
    logger.warn(`The API ${api} SDK is not installed; taking the ${ref} docs for it.`);
    return { ref, dir: docsDirFor(config, ref), sdk: { api } };
  }
  const release = readSdkRelease(sel.sdkDir);
  const ref = docsRefFor({ api: release.api ?? sel.api, version: release.version });
  return { ref, dir: docsDirFor(config, ref), sdk: { dir: sel.sdkDir, api: release.api ?? sel.api, version: release.version } };
}

function docsJson(sel: DocsSelection, tree: string): Record<string, unknown> {
  return { ref: sel.ref, dir: sel.dir, tree, sdk: sel.sdk };
}

/** The synced tree, or an error that says how to sync it. */
function openDocs(sel: DocsSelection): { tree: string; index: DocsIndex } {
  const tree = docsTree(sel.dir);
  if (!tree) {
    const flag = sel.sdk?.api !== undefined ? ` --api ${sel.sdk.api}` : sel.ref ? ` --ref ${sel.ref}` : '';
    throw new OniroError(
      `The ${sel.ref} docs are not synced (no ${sel.dir}). Run \`oniro-app docs sync${flag}\` first ` +
        `(a partial clone of gitcode.com/openharmony/docs, about 100 MB).`,
    );
  }
  return { tree, index: DocsIndex.load(tree) };
}

export interface DocsSearchRun {
  json: Record<string, unknown>;
  result: DocSearchResult;
  tree: string;
}

/** `docs search`: the ranked documents. Shared with `serve mcp`. */
export function runDocsSearch(query: string, opts: DocsSearchOpts): DocsSearchRun {
  const sel = selectDocs(opts);
  const { tree, index } = openDocs(sel);
  const limit = opts.limit !== undefined ? Number(opts.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new OniroError(`--limit expects a positive number, got "${opts.limit}".`);
  }
  const result = index.search(query, { limit, section: opts.section });
  return { json: { docs: docsJson(sel, tree), ...result }, result, tree };
}

export interface DocsShowRun {
  json: Record<string, unknown>;
  result: DocShowResult;
  tree: string;
}

/** `docs show`: one document or section. Shared with `serve mcp`. */
export function runDocsShow(docPath: string, opts: DocsShowOpts): DocsShowRun {
  const sel = selectDocs(opts);
  const { tree, index } = openDocs(sel);
  const maxLines = opts.lines !== undefined ? Number(opts.lines) : undefined;
  if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines <= 0)) {
    throw new OniroError(`--lines expects a positive number, got "${opts.lines}".`);
  }
  const result = index.show(docPath, { heading: opts.heading, maxLines });
  return { json: { docs: docsJson(sel, tree), ...result }, result, tree };
}

/** `docs sync`: clone or update the selected release. */
export async function runDocsSync(opts: DocsOpts): Promise<{ json: Record<string, unknown>; result: SyncDocsResult; sel: DocsSelection }> {
  const { logger } = getRuntime();
  const sel = selectDocs(opts);
  const result = await syncDocs({ ref: sel.ref, dir: sel.dir, logger });
  const tree = docsTree(sel.dir);
  if (tree) DocsIndex.forget(tree);
  return { json: { docs: docsJson(sel, tree ?? sel.dir), sdk: sel.sdk, ...result }, result, sel };
}

/** One hit as text: path and title, the matching sections, the first line. */
export function formatDocHit(h: DocSearchHit): string {
  const lines = [`${h.path}  —  ${h.title}`];
  if (h.headings.length) lines.push(`  sections: ${h.headings.map((x) => `"${x.text}" (line ${x.line})`).join(', ')}`);
  if (h.snippet) lines.push(`  ${h.snippet}`);
  return lines.join('\n');
}

export function registerDocsCommand(program: Command): void {
  const docs = program
    .command('docs')
    .description(
      "Search the OpenHarmony application-development documentation (gitcode.com/openharmony/docs, `en/application-dev`) " +
        'of the release matching the SDK: usage guides, kit API prose, business error codes and platform behaviour, ' +
        "which the SDK typings behind `api search` do not say. `docs sync` clones the release's tree once (a partial, " +
        'sparse clone without figures, about 100 MB) under <sdkRootDir>/docs (ONIRO_DOCS_DIR).',
    );

  const docsOptions = (cmd: Command): Command =>
    cmd
      .option(
        '--api <level>',
        "The SDK API level whose release picks the docs. Default: the project's compileSdkVersion (from the current " +
          'directory or --project), else the newest installed SDK.',
      )
      .option('--sdk <dir>', 'An SDK API directory (holding ets/) whose version picks the docs.')
      .option('--project <dir>', 'The project whose compileSdkVersion picks the SDK (default: the current directory).')
      .option('--ref <branch>', 'A docs branch or tag (`OpenHarmony-6.1-Release`, `master`) instead of the SDK-chosen one.');

  docsOptions(
    docs
      .command('sync')
      .description(
        'Clone the docs of the release matching the SDK (6.1.0.x → OpenHarmony-6.1-Release), or bring an existing ' +
          'clone up to date. Needs git.',
      ),
  )
    .option('--json', 'Print JSON: docs (ref, dir, tree, sdk), files, updated, commit.')
    .action(async (opts: DocsOpts) => {
      const { json, result, sel } = await runDocsSync(opts);
      if (opts.json) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      else {
        process.stdout.write(
          `${result.updated ? 'Updated' : 'Cloned'} the ${sel.ref} docs${result.commit ? ` (${result.commit})` : ''}: ` +
            `${result.files} documents in ${result.dir}\n`,
        );
      }
    });

  docsOptions(
    docs
      .command('search <query...>')
      .description(
        'Ranked search: documents containing every word (any word when none does), scored by where the words occur ' +
          '(title, headings, path, body); a camelCase or dotted identifier also matches by its parts. Each hit names the ' +
          'sections that match, to read with `docs show`. Exits 1 when nothing matches.',
      ),
  )
    .option('--limit <n>', 'At most n hits.', '8')
    .option('--section <dir>', 'Only documents under this subtree: `ui`, `database`, `reference/errorcodes`, `application-models`.')
    .option('--json', 'Print JSON: docs (ref, dir, tree, sdk), query, terms, total, hits (path, title, score, headings, snippet).')
    .action((words: string[], opts: DocsSearchOpts) => {
      const { json, result, tree } = runDocsSearch(words.join(' '), opts);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      } else {
        for (const h of result.hits) process.stdout.write(`${formatDocHit(h)}\n\n`);
        const shown = result.hits.length < result.total ? `${result.hits.length} of ${result.total}` : `${result.total}`;
        process.stdout.write(
          result.total
            ? `${shown} document${result.total === 1 ? '' : 's'} match; paths are relative to ${tree}.\n`
            : 'No document matches; try fewer or different words (component or kit names, decorators, an error code).\n',
        );
      }
      process.exitCode = result.total ? 0 : 1;
    });

  docsOptions(
    docs
      .command('show <path>')
      .description(
        'One document (a path `docs search` printed, relative to en/application-dev), or one section of it by heading. ' +
          'Images and inline HTML are dropped; long documents are cut at --lines with a list of their sections. ' +
          'Exits 1 when the document or heading does not exist, suggesting close paths or the headings.',
      ),
  )
    .option('--heading <text>', 'A heading (or a distinctive part of it, case-insensitive): only that section.')
    .option('--lines <n>', 'At most n lines (default 250).')
    .option(
      '--json',
      'Print JSON: docs (ref, dir, tree, sdk), found, path, text, truncated, lines, headings; on a miss error and suggestions.',
    )
    .action((docPath: string, opts: DocsShowOpts) => {
      const { json, result } = runDocsShow(docPath, opts);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      } else if (result.found) {
        process.stdout.write(`${result.text}\n`);
        if (!opts.heading && result.headings.length) {
          process.stdout.write(`\n[sections: ${result.headings.slice(0, 40).map((h) => h.text).join(' | ')}]\n`);
        }
      } else {
        process.stdout.write(`${result.error}\n`);
        if (result.suggestions.length) {
          process.stdout.write(`  ${opts.heading ? 'headings' : 'close paths'}: ${result.suggestions.join(' | ')}\n`);
        }
      }
      process.exitCode = result.found ? 0 : 1;
    });
}
