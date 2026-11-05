import type { ApiEntry, ApiSymbolKind } from './types.js';
import { fileHeaderTags, mergeDocBlocks, type DocTags } from './jsdoc.js';

/**
 * A scanner for the Node-API C headers in `native/sysroot/usr/include` (not a C
 * parser): top-level function declarations, `typedef`s, `typedef enum` and
 * `typedef struct` with their members, and `#define`s, each with the `/** *\/` doc
 * block right before it. Preprocessor conditionals are ignored, so declarations from
 * every branch are listed.
 */

const MAX_SIGNATURE = 400;

function clean(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim().replace(/\s*;$/, '');
  return s.length > MAX_SIGNATURE ? `${s.slice(0, MAX_SIGNATURE - 1)}…` : s;
}

interface Ctx {
  relPath: string;
  module: string;
  header: DocTags;
  kit?: string;
}

/** Line starts, for offset -> 1-based line. */
function lineIndex(text: string): (pos: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Blank out comments and preprocessor lines inside a statement, keeping length. */
function stripInner(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/^[ \t]*#[^\n]*/gm, (m) => ' '.repeat(m.length));
}

export function extractNativeDeclarations(text: string, relPath: string, module: string): ApiEntry[] {
  const header = fileHeaderTags(text);
  const ctx: Ctx = { relPath, module, header, kit: header.kit ? `@kit.${header.kit}` : undefined };
  const lineOf = lineIndex(text);
  const entries: ApiEntry[] = [];
  const seen = new Set<string>();

  const add = (kind: ApiSymbolKind, name: string, qualifiedName: string, pos: number, signature: string, tags: DocTags) => {
    const key = `${qualifiedName}\u0000${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const e: ApiEntry = {
      name,
      qualifiedName,
      kind,
      language: 'c',
      module: ctx.module,
      file: ctx.relPath,
      line: lineOf(pos),
      signature: clean(signature),
    };
    if (ctx.kit) e.kit = ctx.kit;
    if (tags.since !== undefined) e.since = tags.since;
    if (tags.sinceText) e.sinceText = tags.sinceText;
    if (tags.deprecated !== undefined) e.deprecated = tags.deprecated;
    if (tags.deprecatedSince !== undefined) e.deprecatedSince = tags.deprecatedSince;
    if (tags.useInstead) e.useInstead = tags.useInstead;
    const syscap = tags.syscap ?? ctx.header.syscap;
    if (syscap) e.syscap = syscap;
    if (tags.doc) e.doc = tags.doc;
    entries.push(e);
  };

  let i = 0;
  const n = text.length;
  // The doc block waiting for the next declaration, and where it ended.
  let pending: { block: string; end: number } | undefined;
  const takeDoc = (start: number): DocTags => {
    // Only a doc block separated from the declaration by whitespace belongs to it.
    if (pending && /^\s*$/.test(text.slice(pending.end, start))) {
      const t = mergeDocBlocks([pending.block]);
      pending = undefined;
      return t;
    }
    pending = undefined;
    return {};
  };

  while (i < n) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      if (text.startsWith('/**', i)) {
        const block = text.slice(i, stop);
        pending = /@(file|addtogroup)\b/.test(block) ? undefined : { block, end: stop };
      }
      i = stop;
      continue;
    }
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '#') {
      // A preprocessor line, with backslash continuations.
      let end = i;
      for (;;) {
        const nl = text.indexOf('\n', end);
        if (nl < 0) {
          end = n;
          break;
        }
        if (text[nl - 1] === '\\' || (text[nl - 1] === '\r' && text[nl - 2] === '\\')) {
          end = nl + 1;
          continue;
        }
        end = nl;
        break;
      }
      const line = text.slice(i, end);
      const m = /^#\s*define\s+([A-Za-z_]\w*)(\([^)]*\))?(.*)$/s.exec(line);
      if (m) {
        const name = m[1]!;
        const value = m[3]!.trim();
        // Include guards (`#define FOO_H`) and empty switches carry no API.
        const guard = !value && !m[2] && /(_H_?|_H__)$/.test(name);
        const tags = takeDoc(i);
        if (!guard) add('macro', name, name, i, line.replace(/\\\r?\n/g, ' '), tags);
      }
      i = end;
      continue;
    }
    if (text.startsWith('extern "C"', i)) {
      const brace = text.indexOf('{', i);
      const nl = text.indexOf('\n', i);
      i = brace >= 0 && (nl < 0 || brace < nl) ? brace + 1 : nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '}') {
      i++;
      continue;
    }
    // A statement: up to `;` at brace depth 0, skipping comments and preprocessor lines inside.
    const start = i;
    let depth = 0;
    let j = i;
    let lineStart = true;
    while (j < n) {
      const ch = text[j]!;
      if (text.startsWith('/*', j)) {
        const e = text.indexOf('*/', j + 2);
        j = e < 0 ? n : e + 2;
        continue;
      }
      if (text.startsWith('//', j)) {
        const e = text.indexOf('\n', j);
        j = e < 0 ? n : e;
        continue;
      }
      if (lineStart && ch === '#') {
        const e = text.indexOf('\n', j);
        j = e < 0 ? n : e;
        continue;
      }
      if (ch === '\n') lineStart = true;
      else if (ch !== ' ' && ch !== '\t' && ch !== '\r') lineStart = false;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === ';' && depth <= 0) break;
      j++;
    }
    const stmt = stripInner(text.slice(start, j));
    const tags = takeDoc(start);
    i = j + 1;
    classify(stmt, start, tags);
  }

  function classify(stmt: string, pos: number, tags: DocTags): void {
    const s = stmt.trim();
    if (!s) return;
    let m: RegExpExecArray | null;
    if ((m = /^typedef\s+(enum|struct)\b[^{]*\{([\s\S]*)\}\s*([A-Za-z_]\w*)\s*$/.exec(s))) {
      const isEnum = m[1] === 'enum';
      const name = m[3]!;
      const head = s.slice(0, s.indexOf('{')).trim();
      add(isEnum ? 'enum' : 'struct', name, name, pos, `${head} { ... } ${name}`, tags);
      const body = m[2]!;
      const memberTags: DocTags = { since: tags.since, syscap: tags.syscap };
      if (isEnum) {
        for (const part of body.split(',')) {
          const mm = /^\s*([A-Za-z_]\w*)\s*(=\s*([\s\S]*))?$/.exec(part);
          if (mm) {
            const sig = mm[2] ? `${mm[1]} = ${mm[3]!.replace(/\s+/g, ' ').trim()}` : mm[1]!;
            add('enumMember', mm[1]!, mm[1]!, pos + stmt.indexOf(mm[1]!), sig, memberTags);
          }
        }
      } else {
        for (const part of body.split(';')) {
          const f = part.trim();
          if (!f) continue;
          const fm = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)/.exec(f) ?? /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$/.exec(f);
          if (fm) add('property', fm[1]!, `${name}.${fm[1]}`, pos + stmt.indexOf(f), f, memberTags);
        }
      }
      return;
    }
    if (s.startsWith('typedef')) {
      m = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/.exec(s) ?? /([A-Za-z_]\w*)\s*$/.exec(s);
      if (m) add('typedef', m[1]!, m[1]!, pos, s, tags);
      return;
    }
    // A function declaration: an identifier right before the first `(`, no body, no `=`.
    m = /^([^(=]*?)\b([A-Za-z_]\w*)\s*\(/.exec(s);
    if (m && /\)\s*(__attribute__\s*\(\([\s\S]*\)\)\s*)?$/.test(s) && m[1]!.trim()) {
      add('function', m[2]!, m[2]!, pos, s, tags);
    }
  }

  return entries;
}
