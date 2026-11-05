import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import { noopLogger, type Logger } from '../ports/logger.js';
import type { ApiIndex } from './types.js';
import { loadApiIndex } from './buildIndex.js';
import { installedApiLevels, resolveApiSdk } from './resolveSdk.js';
import { nameParts, searchApi, showApi, type ApiShowResult } from './search.js';

/**
 * `api show` beyond the exact lookup: on a miss, which other installed SDKs declare
 * the symbol, and the close names this SDK does declare. This is the answer to "does
 * this member exist at this API level": a hallucinated member gets the real ones.
 */

export interface ApiElsewhere {
  api: number;
  /** The lowest `@since` of its declarations there. */
  since?: number;
}

/**
 * Close names for a symbol `index` does not declare: for `Parent.member`, the
 * members of `Parent` sharing a camelCase part with `member` (most shared first), then
 * the search hits for `member` itself, else the first functions and methods of `Parent`.
 */
export function suggestApiSymbols(index: ApiIndex, symbol: string, limit = 5): string[] {
  const s = symbol.trim().replace(/^@+/, '').replace(/\(.*$/, '').replace(/[#:]/g, '.');
  const dot = s.lastIndexOf('.');
  const parent = dot > 0 ? s.slice(0, dot) : undefined;
  const member = dot > 0 ? s.slice(dot + 1) : s;
  const out: string[] = [];
  const push = (q: string): void => {
    if (!out.includes(q) && q !== s) out.push(q);
  };
  if (parent) {
    const wanted = new Set(nameParts(member));
    const scored = new Map<string, number>();
    for (const e of index.entries) {
      const q = e.qualifiedName;
      const owner = q.slice(0, Math.max(0, q.lastIndexOf('.')));
      if (owner !== parent && !owner.endsWith(`.${parent}`)) continue;
      const shared = nameParts(e.name).filter((p) => wanted.has(p)).length;
      if (shared) scored.set(q, Math.max(scored.get(q) ?? 0, shared));
    }
    [...scored.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .forEach(([q]) => push(q));
  }
  for (const h of searchApi(index, member, { limit: limit * 2 }).hits) {
    if (out.length >= limit) break;
    push(h.qualifiedName);
  }
  // Nothing alike: what the parent does declare (`router.navigateTo` -> `router.pushUrl`, ...).
  if (!out.length && parent) {
    for (const e of index.entries) {
      if (out.length >= limit) break;
      if (e.qualifiedName === `${parent}.${e.name}` && (e.kind === 'function' || e.kind === 'method')) push(e.qualifiedName);
    }
  }
  return out.slice(0, limit);
}

export interface FindInOtherSdksOptions {
  cacheDir?: string;
  kit?: string;
  logger?: Logger;
}

/** The installed SDKs other than `exceptSdkDir` that declare `symbol`, newest first. Builds their indexes if needed. */
export function findApiInOtherSdks(
  config: ConfigProvider,
  symbol: string,
  exceptSdkDir: string,
  opts: FindInOtherSdksOptions = {},
): ApiElsewhere[] {
  const logger = opts.logger ?? noopLogger;
  const out: ApiElsewhere[] = [];
  for (const api of installedApiLevels(config)) {
    let sdkDir: string;
    try {
      sdkDir = resolveApiSdk(config, { api }).sdkDir;
    } catch {
      continue;
    }
    if (path.resolve(sdkDir) === path.resolve(exceptSdkDir)) continue;
    let r: ApiShowResult;
    try {
      r = showApi(loadApiIndex(sdkDir, { cacheDir: opts.cacheDir, logger }).index, symbol, { kit: opts.kit });
    } catch (err) {
      logger.warn(`Could not read the API ${api} SDK: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!r.found) continue;
    const sinces = r.entries.map((e) => e.since).filter((x): x is number => x !== undefined);
    out.push(sinces.length ? { api, since: Math.min(...sinces) } : { api });
  }
  return out;
}
