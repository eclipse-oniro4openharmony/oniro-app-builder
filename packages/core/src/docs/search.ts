import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Search over the OpenHarmony application-development documentation (`docs sync`
 * clones `en/application-dev` of gitcode.com/openharmony/docs). The SDK typings
 * behind `api search` / `api show` say whether a symbol exists and with what
 * signature; the docs say how an API is used, which business error codes a kit
 * throws and how the platform behaves. The index is deterministic, built in memory
 * in a few seconds from titles, headings and an inverted word index, and answers a
 * query in milliseconds; bodies are read on demand.
 */

export interface DocEntry {
  /** Path relative to the `en/application-dev` tree, e.g. `ui/arkts-navigation-jump.md`. */
  path: string;
  title: string;
  /** Every `##`–`####` heading with its 1-based line. */
  headings: DocHeading[];
  bytes: number;
}

export interface DocHeading {
  line: number;
  level: number;
  text: string;
}

export interface DocSearchHit {
  path: string;
  title: string;
  score: number;
  /** Headings that contain a query word (at most 6), to pass to `show`. */
  headings: { line: number; text: string }[];
  /** First paragraph after the title, trimmed. */
  snippet: string;
}

export interface DocSearchOptions {
  /** At most n hits (default 8, at most 30). */
  limit?: number;
  /** Only documents under this subtree, e.g. `ui`, `reference/errorcodes`. */
  section?: string;
}

export interface DocSearchResult {
  query: string;
  /** The words the query was read as. */
  terms: string[];
  total: number;
  hits: DocSearchHit[];
}

export interface DocShowOptions {
  /** A heading (or a distinctive part of it, case-insensitive): only that section. */
  heading?: string;
  /** Line cap (default 250, at most 1200). */
  maxLines?: number;
}

export type DocShowResult =
  | {
      found: true;
      path: string;
      /** The text (images and inline HTML dropped), cut at `maxLines` with a note. */
      text: string;
      truncated: boolean;
      /** The headings inside what was shown. */
      headings: { line: number; text: string }[];
      /** Lines of the whole section before the cap. */
      lines: number;
    }
  | {
      found: false;
      path: string;
      error: string;
      /** Similar document paths, or the document's headings when the heading did not match. */
      suggestions: string[];
    };

const SKIP_DIRS = new Set(['figures', 'figure', 'images', 'image', 'public_sys-resources']);

/** Every `.md` under `tree`, sorted, skipping figure directories. */
export function listMarkdown(tree: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(tree);
  return out.sort();
}

const WORD = /[a-z0-9_@.]+/g;

/** Lower-cased words of a text: identifiers keep their dots, 2–40 chars, no long digit runs (hashes, ids). */
export function docTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(WORD)) {
    const w = m[0].replace(/^[.@]+|[.@]+$/g, '');
    if (w.length >= 2 && w.length <= 40 && !/^\d{13,}$/.test(w)) out.push(w);
  }
  return out;
}

export interface QueryTerm {
  term: string;
  /** 1 for a word of the query, 0.4 for a part of a camelCase or dotted identifier. */
  weight: number;
}

/**
 * The query's words plus the parts of camelCase and dotted identifiers
 * (`NavPathStack` → nav, path, stack), so a guide that says "path stack" still matches;
 * the parts weigh less and are not required.
 */
export function docQueryTerms(query: string): QueryTerm[] {
  const out = new Map<string, number>();
  const add = (t: string, w: number): void => {
    if (t.length >= 2 && (out.get(t) ?? 0) < w) out.set(t, w);
  };
  for (const w of docTokens(query)) {
    add(w, 1);
    for (const p of w.split(/[._]/)) if (p.length >= 3 && p !== w) add(p, 0.4);
  }
  for (const m of query.matchAll(/[A-Z][a-z]+|[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g)) {
    if (m[0].length >= 3) add(m[0].toLowerCase(), 0.4);
  }
  return [...out].map(([term, weight]) => ({ term, weight }));
}

/** Whether `term` occurs in `text` as a whole word (a trailing API-level suffix such as `insert10+` still counts). */
export function wordIn(text: string, term: string): boolean {
  let i = text.indexOf(term);
  while (i >= 0) {
    const before = i === 0 ? '' : (text[i - 1] ?? '');
    const after = text[i + term.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z]/.test(after)) return true;
    i = text.indexOf(term, i + 1);
  }
  return false;
}

/**
 * A copy that owns its characters: V8 substrings are slices that keep their source
 * alive, which would pin every file's text behind 200k short index keys.
 */
const flat = (s: string): string => Buffer.from(s, 'utf8').toString('utf8');

function stripMd(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}

/** Title and headings of one document. */
export function parseDoc(rel: string, text: string): DocEntry {
  const lines = text.split('\n');
  let title = '';
  const headings: DocHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? '');
    if (!m) continue;
    const level = (m[1] ?? '#').length;
    const text = flat(stripMd(m[2] ?? ''));
    if (level === 1 && !title) title = text;
    else headings.push({ line: i + 1, level, text });
  }
  if (!title) title = path.basename(rel, '.md');
  return { path: rel, title, headings, bytes: text.length };
}

/**
 * Distinct index words of a document: its text plus the words of its path. A dotted
 * identifier also contributes its parts (`this.pathstack.pushpathbyname` → pathstack,
 * pushpathbyname) and a word with a trailing API-level suffix its stem
 * (`pushpathbyname10` → pushpathbyname), so the words a reader types are the words
 * the index holds.
 */
export function docWords(rel: string, text: string): Set<string> {
  const words = new Set<string>();
  const add = (w: string): void => {
    words.add(w);
    const stem = /^([a-z_]{3,})\d{1,2}$/.exec(w)?.[1];
    if (stem !== undefined) words.add(stem);
  };
  for (const w of docTokens(text)) {
    add(w);
    if (w.includes('.')) for (const p of w.split('.')) if (p.length >= 3) add(p);
  }
  for (const w of docTokens(rel.replace(/[-/]/g, ' '))) words.add(w);
  return words;
}

const cache = new Map<string, DocsIndex>();

export class DocsIndex {
  /** word → ascending document ids (packed: 4 bytes per occurrence). */
  private readonly postings = new Map<string, Int32Array>();

  private constructor(
    readonly tree: string,
    readonly docs: readonly DocEntry[],
    words: Iterable<Set<string>>,
    /** Build time, ms. */
    readonly buildMs: number,
  ) {
    const lists = new Map<string, number[]>();
    let id = 0;
    for (const set of words) {
      for (const w of set) {
        const list = lists.get(w);
        if (list) list.push(id);
        else lists.set(flat(w), [id]);
      }
      id++;
    }
    for (const [w, list] of lists) this.postings.set(w, Int32Array.from(list));
  }

  /** The index of a tree, built on the first call of a process and kept. */
  static load(tree: string): DocsIndex {
    const key = path.resolve(tree);
    const hit = cache.get(key);
    if (hit) return hit;
    const started = Date.now();
    const docs: DocEntry[] = [];
    const words: Set<string>[] = [];
    for (const abs of listMarkdown(key)) {
      const rel = path.relative(key, abs).split(path.sep).join('/');
      const text = fs.readFileSync(abs, 'utf8');
      docs.push(parseDoc(rel, text));
      words.push(docWords(rel, text));
    }
    const idx = new DocsIndex(key, docs, words, Date.now() - started);
    cache.set(key, idx);
    return idx;
  }

  /** An index over in-memory documents (tests). `tree` is used by `show` for reading files. */
  static fromDocs(tree: string, docs: { path: string; text: string }[]): DocsIndex {
    return new DocsIndex(
      tree,
      docs.map((d) => parseDoc(d.path, d.text)),
      docs.map((d) => docWords(d.path, d.text)),
      0,
    );
  }

  /** Forget the cached index of a tree (after a sync). */
  static forget(tree: string): void {
    cache.delete(path.resolve(tree));
  }

  get size(): number {
    return this.docs.length;
  }

  private has(term: string): ArrayLike<number> & Iterable<number> {
    return this.postings.get(term) ?? [];
  }

  /**
   * Documents containing every word of the query (any of them when none does), scored by
   * where the words occur: title, headings, path, body; a document whose title is exactly a
   * query word, or that contains the whole query in a title or heading, ranks higher; the
   * generated API reference ranks a little below the guides, system-API pages and tables of
   * contents below everything.
   */
  search(query: string, o: DocSearchOptions = {}): DocSearchResult {
    const terms = docQueryTerms(query);
    const full = terms.filter((t) => t.weight === 1);
    const result: DocSearchResult = { query, terms: terms.map((t) => t.term), total: 0, hits: [] };
    if (!terms.length) return result;
    const limit = Math.max(1, Math.min(o.limit ?? 8, 30));
    const section = o.section?.replace(/^\/+|\/+$/g, '').toLowerCase();
    const inScope = (d: DocEntry): boolean =>
      !section || d.path.toLowerCase().startsWith(`${section}/`) || d.path.toLowerCase().includes(`/${section}/`);
    const phrase = query.trim().toLowerCase();
    const presentBy = new Map<number, QueryTerm[]>();
    for (const t of terms) {
      for (const id of this.has(t.term)) {
        const l = presentBy.get(id);
        if (l) l.push(t);
        else presentBy.set(id, [t]);
      }
    }
    const scored = (requireAll: boolean) => {
      const out: { d: DocEntry; score: number; headings: { line: number; text: string }[] }[] = [];
      for (const [id, present] of presentBy) {
        const d = this.docs[id];
        if (!d) continue;
        const fullPresent = present.filter((t) => t.weight === 1).length;
        if (!inScope(d) || (requireAll && fullPresent < full.length)) continue;
        const title = d.title.toLowerCase();
        const p = d.path.toLowerCase();
        let score = 0;
        const headingHits: { line: number; text: string; n: number }[] = [];
        for (const h of d.headings) {
          const ht = h.text.toLowerCase();
          const n = present.reduce((a, t) => a + (wordIn(ht, t.term) ? t.weight : 0), 0);
          if (n) headingHits.push({ line: h.line, text: h.text, n });
        }
        for (const t of present) {
          if (wordIn(title, t.term)) score += 8 * t.weight;
          if (wordIn(p, t.term)) score += 3 * t.weight;
          score += t.weight;
        }
        if (full.some((t) => title === t.term || title.replace(/\s*\(.*\)$/, '') === t.term)) score += 6;
        if (headingHits.length) score += Math.min(12, headingHits.reduce((a, h) => a + h.n * 2, 0));
        if (phrase.length > 3) {
          if (title.includes(phrase)) score += 20;
          else if (headingHits.some((h) => h.text.toLowerCase().includes(phrase))) score += 10;
        }
        if (p.startsWith('reference/apis-')) score -= 2;
        if (/-sys\.md$/.test(p) || /\(system api\)/i.test(title)) score -= 12;
        if (/\/(readme|summary)\.md$/i.test(p) || /^readme/i.test(p)) score -= 6;
        if (fullPresent === full.length) score += 4;
        headingHits.sort((a, b) => b.n - a.n || a.line - b.line);
        out.push({
          d,
          score: Math.round(score * 10) / 10,
          headings: headingHits.slice(0, 6).map(({ line, text }) => ({ line, text })),
        });
      }
      return out;
    };
    let hits = scored(true);
    if (!hits.length) hits = scored(false);
    hits.sort((a, b) => b.score - a.score || a.d.path.localeCompare(b.d.path));
    result.total = hits.length;
    result.hits = hits.slice(0, limit).map(({ d, score, headings }) => ({
      path: d.path,
      title: d.title,
      score,
      headings,
      snippet: this.snippet(d),
    }));
    return result;
  }

  private snippet(d: DocEntry): string {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.tree, d.path), 'utf8');
    } catch {
      return '';
    }
    const lines = text.split('\n');
    for (let i = lines.findIndex((l) => /^#\s/.test(l)) + 1; i < lines.length; i++) {
      const s = stripMd(lines[i] ?? '');
      if (s && !/^[#>|<-]/.test(s)) return s.length > 220 ? `${s.slice(0, 217)}…` : s;
    }
    return '';
  }

  /**
   * A document, or one of its sections: from the heading that matches `heading`
   * (exactly, else by substring, case-insensitive) to the next heading of the same or a
   * higher level. Image lines and inline HTML are dropped; the text is cut at `maxLines`
   * with a note of what was left out.
   */
  show(rel: string, o: DocShowOptions = {}): DocShowResult {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^en\/application-dev\//, '');
    const abs = path.resolve(this.tree, clean);
    const inside = abs.startsWith(this.tree + path.sep);
    if (!inside || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      const base = path.basename(clean, '.md').toLowerCase();
      let suggestions = this.docs
        .filter((d) => d.path.toLowerCase().includes(base))
        .slice(0, 5)
        .map((d) => d.path);
      if (!suggestions.length) suggestions = this.search(base.replace(/[-_]/g, ' '), { limit: 5 }).hits.map((h) => h.path);
      return { found: false, path: clean, error: `No document at ${clean}.`, suggestions };
    }
    const text = fs.readFileSync(abs, 'utf8');
    const entry = this.docs.find((d) => d.path === clean) ?? parseDoc(clean, text);
    const lines = text.split('\n');
    let from = 0;
    let to = lines.length;
    if (o.heading) {
      const needle = o.heading.toLowerCase().replace(/^#+\s*/, '').trim();
      const h =
        entry.headings.find((x) => x.text.toLowerCase() === needle) ??
        entry.headings.find((x) => x.text.toLowerCase().includes(needle));
      if (!h) {
        return {
          found: false,
          path: clean,
          error: `No heading matching "${o.heading}" in ${clean}.`,
          suggestions: entry.headings.slice(0, 30).map((x) => x.text),
        };
      }
      from = h.line - 1;
      const next = entry.headings.find((x) => x.line > h.line && x.level <= h.level);
      to = next ? next.line - 1 : lines.length;
    }
    const max = Math.max(20, Math.min(o.maxLines ?? 250, 1200));
    const body = lines
      .slice(from, to)
      .filter((l) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l) && !/^\s*<img\b/i.test(l))
      .map((l) => l.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?(p|div|span|b|i|em|strong|sup|sub)>/gi, ''));
    const truncated = body.length > max;
    const shown =
      body.slice(0, max).join('\n') +
      (truncated ? `\n\n[… ${body.length - max} more lines; ask for one section with heading]` : '');
    return {
      found: true,
      path: clean,
      text: shown,
      truncated,
      lines: body.length,
      headings: entry.headings.filter((h) => h.line > from && h.line <= to).map(({ line, text: t }) => ({ line, text: t })),
    };
  }
}
