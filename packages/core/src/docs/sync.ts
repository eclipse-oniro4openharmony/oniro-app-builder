import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import { OniroError } from '../ports/errors.js';
import type { Logger } from '../ports/logger.js';
import { runProcess } from '../hdc/exec.js';
import { getSdkRootDir } from '../sdk/paths.js';
import { listMarkdown } from './search.js';

/** The OpenHarmony documentation repository. */
export const DOCS_REPO = 'https://gitcode.com/openharmony/docs';
/** The part of the repository `docs search` reads; device, kernel and the Chinese tree stay out. */
export const DOCS_SPARSE_PATH = 'en/application-dev';
/** Sparse-checkout patterns (non-cone): the tree without its figures, which are about 90% of its bytes. */
export const DOCS_SPARSE_PATTERNS: readonly string[] = [
  `/${DOCS_SPARSE_PATH}/`,
  '!**/figures/',
  '!**/*.png',
  '!**/*.gif',
  '!**/*.jpg',
  '!**/*.jpeg',
];

/**
 * The release branch of the docs repository for an SDK: from its version
 * (`oh-uni-package.json`: `6.1.0.31` → `OpenHarmony-6.1-Release`, `5.1.0.107` →
 * `OpenHarmony-5.1.0-Release`), else from the API level (18 → 5.1.0, 20 → 6.0,
 * 23 → 6.1, 26 → 7.0), else `master`.
 */
export function docsRefFor(sdk: { api?: number; version?: string }): string {
  const m = sdk.version ? /^(\d+)\.(\d+)\.(\d+)/.exec(sdk.version) : null;
  if (m) {
    const [, major, minor, patch] = m;
    return `OpenHarmony-${Number(major) >= 6 ? `${major}.${minor}` : `${major}.${minor}.${patch}`}-Release`;
  }
  const api = sdk.api;
  if (api === undefined) return 'master';
  if (api <= 18) return 'OpenHarmony-5.1.0-Release';
  if (api <= 20) return 'OpenHarmony-6.0-Release';
  if (api <= 23) return 'OpenHarmony-6.1-Release';
  if (api <= 26) return 'OpenHarmony-7.0-Release';
  return 'master';
}

/** `{ api, version }` of an SDK API directory, from `ets/oh-uni-package.json`; empty when unreadable. */
export function readSdkRelease(sdkDir: string): { api?: number; version?: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sdkDir, 'ets', 'oh-uni-package.json'), 'utf8')) as {
      apiVersion?: string | number;
      version?: string;
    };
    const api = Number(pkg.apiVersion);
    return { api: Number.isFinite(api) ? api : undefined, version: typeof pkg.version === 'string' ? pkg.version : undefined };
  } catch {
    return {};
  }
}

/** Where the clones live: the `docsDir` config key, default `<sdkRootDir>/docs`. */
export function getDocsRootDir(config: ConfigProvider): string {
  return config.get('docsDir', path.join(getSdkRootDir(config), 'docs'));
}

/** The clone of one release: `<docs root>/<ref>`. */
export function docsDirFor(config: ConfigProvider, ref: string): string {
  return path.join(getDocsRootDir(config), ref);
}

/** The `en/application-dev` tree of a clone, or null when the release has not been synced. */
export function docsTree(docsDir: string): string | null {
  const tree = path.join(docsDir, DOCS_SPARSE_PATH);
  return fs.existsSync(tree) ? tree : null;
}

export interface SyncDocsOptions {
  /** The branch or tag to clone. */
  ref: string;
  /** Where to clone (normally `docsDirFor(config, ref)`). */
  dir: string;
  /** Repository URL (default {@link DOCS_REPO}). */
  repo?: string;
  logger?: Logger;
  /** Per git step; the clone of a release takes a minute or two. Default 10 minutes. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface SyncDocsResult {
  dir: string;
  ref: string;
  /** Markdown files under `en/application-dev`. */
  files: number;
  /** False when the clone was created, true when an existing one was brought up to date. */
  updated: boolean;
  /** The commit the tree is at. */
  commit?: string;
}

/**
 * Clone or update the documentation of one release: a partial (`--filter=blob:none`),
 * depth-1, sparse clone of `en/application-dev` without its figures, about 100 MB
 * instead of the 2 GB a plain clone of the tree is. A second call on an existing
 * clone fetches the branch head and resets to it. Needs `git` on the PATH.
 */
export async function syncDocs(opts: SyncDocsOptions): Promise<SyncDocsResult> {
  const { ref, dir } = opts;
  const repo = opts.repo ?? DOCS_REPO;
  const logger = opts.logger;
  const git = async (args: readonly string[], cwd?: string): Promise<string> => {
    const r = await runProcess({
      command: 'git',
      args,
      cwd,
      timeoutMs: opts.timeoutMs ?? 600_000,
      abortSignal: opts.abortSignal,
      onOutput: (chunk) => {
        for (const line of chunk.split(/\r?\n/)) if (line.trim()) logger?.debug(`git: ${line.trim()}`);
      },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new OniroError(/ENOENT/.test(msg) ? 'git is not installed or not on the PATH; `docs sync` needs it.' : msg);
    });
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      throw new OniroError(`git ${args[0]} failed (exit ${r.code}): ${tail}`);
    }
    return r.stdout;
  };

  const exists = fs.existsSync(path.join(dir, '.git'));
  if (exists) {
    logger?.info(`Updating the ${ref} docs in ${dir}`);
    await git(['fetch', '--depth', '1', 'origin', ref], dir);
    await git(['sparse-checkout', 'set', '--no-cone', ...DOCS_SPARSE_PATTERNS], dir);
    await git(['reset', '--hard', 'FETCH_HEAD'], dir);
  } else {
    logger?.info(`Cloning the ${ref} docs (${DOCS_SPARSE_PATH} only) into ${dir}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // No checkout until the sparse patterns are set: blobs are fetched only for what they select.
    await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', ref, repo, dir]);
    await git(['sparse-checkout', 'set', '--no-cone', ...DOCS_SPARSE_PATTERNS], dir);
    await git(['checkout', ref], dir);
  }
  const commit = (await git(['rev-parse', '--short', 'HEAD'], dir)).trim() || undefined;
  const tree = docsTree(dir);
  const files = tree ? listMarkdown(tree).length : 0;
  if (!files) throw new OniroError(`The ${ref} clone at ${dir} holds no Markdown under ${DOCS_SPARSE_PATH}.`);
  return { dir, ref, files, updated: exists, commit };
}
