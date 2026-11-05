import type { ApiEntry, ApiIndex, ApiSymbolKind } from './types.js';

/**
 * Ranked token search and exact lookup over an `ApiIndex`, in process.
 *
 * Each whitespace-separated query token must match an entry, in its name or
 * qualified name, or in its doc line; the scores add up. Per token, best first:
 * the exact name, the exact qualified name or a dotted suffix of it
 * (`router.pushUrl`), a name prefix, a camelCase or snake_case part of the name
 * (`Path` in `pushPathByName`), a substring of the name, then a word in the doc
 * line. Ties go to types over members, then current over deprecated, public over
 * system APIs, and shorter names.
 */

export interface ApiSearchOptions {
  /** Only entries a kit exports: `ArkUI`, `@kit.ArkUI` (case-insensitive). */
  kit?: string;
  /** Only these kinds. */
  kinds?: readonly ApiSymbolKind[];
  /** Only `arkts` (ArkTS declarations) or `c` (Node-API headers). */
  language?: 'arkts' | 'c';
  /** Leave out `@deprecated` entries. */
  noDeprecated?: boolean;
  /** Leave out `@systemapi` entries. */
  noSystemApi?: boolean;
  /** At most this many hits. Default 20. */
  limit?: number;
}

export interface ApiSearchHit extends ApiEntry {
  score: number;
  /** Other declarations of the same symbol in the same file (overloads), not listed separately. */
  overloads?: number;
}

export interface ApiSearchResult {
  query: string;
  /** Distinct symbols that matched, before the limit. */
  total: number;
  hits: ApiSearchHit[];
}

/** `ArkUI`, `arkui`, `@kit.ArkUI` -> `@kit.arkui`. */
export function normalizeKit(kit: string): string {
  const k = kit.trim().toLowerCase();
  return k.startsWith('@kit.') ? k : `@kit.${k.replace(/^kit\./, '')}`;
}

/** `pushPathByName` -> push, path, by, name; `napi_create_object` -> napi, create, object. */
export function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$.]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

const KIND_RANK: Record<ApiSymbolKind, number> = {
  component: 0,
  decorator: 0,
  class: 1,
  interface: 1,
  namespace: 1,
  enum: 2,
  function: 2,
  type: 3,
  struct: 2,
  typedef: 3,
  method: 3,
  constructor: 4,
  macro: 4,
  property: 4,
  variable: 4,
  enumMember: 5,
};

interface Prepared {
  e: ApiEntry;
  name: string;
  qualified: string;
  /** Computed on first use: most entries never get that far. */
  parts?: string[];
  doc?: string;
}

const prepared = new WeakMap<ApiIndex, Prepared[]>();

function prepare(index: ApiIndex): Prepared[] {
  let p = prepared.get(index);
  if (!p) {
    p = index.entries.map((e) => ({ e, name: e.name.toLowerCase(), qualified: e.qualifiedName.toLowerCase() }));
    prepared.set(index, p);
  }
  return p;
}

/** A query token: `@Local` -> `local`, `NavPathStack.pushPathByName()` -> `navpathstack.pushpathbyname`. */
function normalizeToken(t: string): string {
  return t
    .replace(/^@+/, '')
    .replace(/\(.*$/, '')
    .replace(/[#:]/g, '.')
    .toLowerCase();
}

interface Token {
  raw: string;
  t: string;
  /** Word-start match in the doc line. */
  doc: RegExp;
}

function makeToken(raw: string): Token {
  const t = normalizeToken(raw);
  return { raw, t, doc: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) };
}

function tokenScore(p: Prepared, { raw, t, doc }: Token): number {
  if (t.includes('.')) {
    if (p.qualified === t) return p.e.qualifiedName === raw ? 110 : 105;
    if (p.qualified.endsWith(`.${t}`)) return 100;
    if (p.qualified.startsWith(t)) return 50;
    if (p.qualified.includes(t)) return 30;
    return 0;
  }
  if (p.name.includes(t)) {
    if (p.name === t) return p.e.name === raw.replace(/^@+/, '') ? 100 : 95;
    if (p.name.startsWith(t)) return 60;
    // Any camelCase or snake_case part match is a substring of the name, so parts are only split here.
    const parts = (p.parts ??= nameParts(p.e.name));
    if (parts.includes(t)) return 45;
    if (t.length >= 2 && parts.some((x) => x.startsWith(t))) return 35;
    // `pushpath` spans parts of `pushPathByName`.
    if (t.length >= 3) return 25;
  }
  // A member of the namespace or class the token names (`router` -> `router.pushUrl`), or partly
  // names (`column` -> `ColumnAttribute.alignItems`).
  if (p.qualified.includes(t)) {
    const owner = p.qualified.slice(0, p.qualified.length - p.name.length - 1);
    if (owner.split('.').includes(t)) return 20;
    if (t.length >= 3 && owner.includes(t)) return 15;
  }
  if (t.length >= 3 && p.e.doc) {
    p.doc ??= p.e.doc.toLowerCase();
    if (doc.test(p.doc)) return 10;
  }
  return 0;
}

/** Ranked search of `index` for `query`. */
export function searchApi(index: ApiIndex, query: string, opts: ApiSearchOptions = {}): ApiSearchResult {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map(makeToken)
    .filter((tok) => tok.t);
  const limit = opts.limit ?? 20;
  if (!tokens.length) return { query, total: 0, hits: [] };
  const kit = opts.kit ? normalizeKit(opts.kit) : undefined;
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : undefined;

  // Best scoring declaration per symbol (qualified name, kind and file); the rest count as overloads.
  const best = new Map<string, ApiSearchHit>();
  for (const p of prepare(index)) {
    const e = p.e;
    if (kit && (e.kit ?? '').toLowerCase() !== kit) continue;
    if (kinds && !kinds.has(e.kind)) continue;
    if (opts.language && e.language !== opts.language) continue;
    if (opts.noDeprecated && e.deprecated !== undefined) continue;
    if (opts.noSystemApi && e.systemApi) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < tokens.length; i++) {
      const s = tokenScore(p, tokens[i]!);
      if (!s) {
        ok = false;
        break;
      }
      score += s;
    }
    if (!ok) continue;
    const key = `${e.qualifiedName}\u0000${e.kind}\u0000${e.file}`;
    const prev = best.get(key);
    if (prev) {
      prev.overloads = (prev.overloads ?? 0) + 1;
      continue;
    }
    best.set(key, { ...e, score });
  }
  const hits = [...best.values()].sort(compareHits);
  return { query, total: hits.length, hits: hits.slice(0, limit) };
}

function compareHits(a: ApiSearchHit, b: ApiSearchHit): number {
  return (
    b.score - a.score ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    Number(a.deprecated !== undefined) - Number(b.deprecated !== undefined) ||
    Number(!!a.systemApi) - Number(!!b.systemApi) ||
    a.qualifiedName.length - b.qualifiedName.length ||
    a.qualifiedName.localeCompare(b.qualifiedName) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );
}

export interface ApiShowResult {
  symbol: string;
  found: boolean;
  /** Every declaration of it (overloads included), exact qualified-name matches first. */
  entries: ApiEntry[];
}

/**
 * Exact lookup: the declarations whose qualified name is `symbol` (`NavPathStack.pushPathByName`,
 * `router.pushUrl`, `Column`, `@Local`), or, when none is, whose qualified name ends with
 * `.symbol` (`Preferences.get` finds `preferences.Preferences.get`). Case-sensitive.
 */
export function showApi(index: ApiIndex, symbol: string, opts: Pick<ApiSearchOptions, 'kit' | 'kinds' | 'language'> = {}): ApiShowResult {
  const s = symbol.trim().replace(/^@+/, '').replace(/\(.*$/, '').replace(/[#:]/g, '.');
  const kit = opts.kit ? normalizeKit(opts.kit) : undefined;
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : undefined;
  const keep = (e: ApiEntry): boolean =>
    (!kit || (e.kit ?? '').toLowerCase() === kit) &&
    (!kinds || kinds.has(e.kind)) &&
    (!opts.language || e.language === opts.language);
  let entries = index.entries.filter((e) => e.qualifiedName === s && keep(e));
  if (!entries.length) entries = index.entries.filter((e) => e.qualifiedName.endsWith(`.${s}`) && keep(e));
  entries = [...entries].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.qualifiedName.localeCompare(b.qualifiedName) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  return { symbol, found: entries.length > 0, entries };
}
