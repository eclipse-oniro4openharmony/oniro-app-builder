/**
 * A small token scanner and declaration finder for ArkTS (`.ets`) sources.
 *
 * Plain TypeScript cannot parse ArkTS: `struct`, the UI trailing-closure syntax
 * (`Column() { Text('a') }`) and `$r`/`$$` are not TypeScript. The screen
 * inventory only needs tokens with line numbers, matched brackets, and the
 * struct, class, function and method declarations with their decorators, so a
 * scanner that gets comments, strings, template literals and regex literals
 * right is enough, needs no dependency, and does not depend on an SDK being
 * installed.
 */

export type TokenKind = 'ident' | 'string' | 'template' | 'number' | 'punct' | 'regex' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Source text of the token (for strings and templates, including the quotes). */
  value: string;
  /** For `string` and `template` tokens: the unquoted text (a template's static parts only). */
  text: string;
  /** 1-based line of the token's first character. */
  line: number;
  start: number;
  end: number;
}

export interface SourceComment {
  text: string;
  line: number;
}

export interface Decorator {
  name: string;
  /** Index of the `(` of the decorator's arguments, when it has any. */
  argsOpen?: number;
}

export interface Declaration {
  kind: 'struct' | 'class' | 'function' | 'enum' | 'namespace' | 'object';
  name: string;
  decorators: Decorator[];
  /** Index of the name token. */
  nameIndex: number;
  line: number;
  /** Indices of the body's `{` and `}`. */
  bodyOpen: number;
  bodyClose: number;
}

export interface Method {
  name: string;
  decorators: Decorator[];
  nameIndex: number;
  line: number;
  bodyOpen: number;
  bodyClose: number;
}

export interface ScannedSource {
  src: string;
  tokens: Token[];
  comments: SourceComment[];
  /** For each bracket token, the index of its partner; -1 for other tokens or an unbalanced bracket. */
  match: Int32Array;
  declarations: Declaration[];
}

const PUNCT3 = new Set(['===', '!==', '...', '**=', '<<=', '>>=', '&&=', '||=', '??=']);
const PUNCT2 = new Set([
  '=>', '==', '!=', '&&', '||', '??', '?.', '<=', '>=', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '**', '<<', '>>',
]);
/** After these keywords a `/` starts a regex literal, not a division. */
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$\u0080-￿]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_$\u0080-￿]/.test(c);
}

const EOF: Token = { kind: 'eof', value: '', text: '', line: 0, start: 0, end: 0 };

/** Tokenize an ArkTS/TypeScript source, keeping comments aside. */
export function scanEts(src: string): ScannedSource {
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const tokens: Token[] = [];
  const comments: SourceComment[] = [];
  const n = src.length;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number, text = ''): void => {
    tokens.push({ kind, value: src.slice(start, end), text, line: lineAt(start), start, end });
  };

  /** Skip a quoted string starting at `start` (the quote); returns the index after the closing quote. */
  const skipQuoted = (start: number): number => {
    const q = src[start];
    let j = start + 1;
    while (j < n && src[j] !== q) {
      if (src[j] === '\\') j++;
      else if (src[j] === '\n') break; // unterminated: stop at the line end
      j++;
    }
    return Math.min(j + 1, n);
  };

  /** Skip a template literal starting at the backtick; returns [end, static text]. */
  const skipTemplate = (start: number): [number, string] => {
    let j = start + 1;
    let text = '';
    while (j < n && src[j] !== '`') {
      const c = src[j] ?? '';
      if (c === '\\') {
        text += src[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (c === '$' && src[j + 1] === '{') {
        j = skipExpression(j + 2);
        text += ' ';
        continue;
      }
      text += c;
      j++;
    }
    return [Math.min(j + 1, n), text];
  };

  /** Skip a `${ ... }` expression body; `start` is just after `${`. Returns the index after the closing `}`. */
  const skipExpression = (start: number): number => {
    let depth = 1;
    let j = start;
    while (j < n && depth > 0) {
      const c = src[j];
      if (c === '"' || c === "'") j = skipQuoted(j);
      else if (c === '`') j = skipTemplate(j)[0];
      else if (c === '/' && src[j + 1] === '/') {
        while (j < n && src[j] !== '\n') j++;
      } else if (c === '/' && src[j + 1] === '*') {
        const e = src.indexOf('*/', j + 2);
        j = e < 0 ? n : e + 2;
      } else {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
      }
    }
    return j;
  };

  const regexAllowed = (): boolean => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.kind === 'ident') return REGEX_AFTER_KEYWORD.has(prev.value);
    if (prev.kind === 'punct') return !(prev.value === ')' || prev.value === ']' || prev.value === '}' || prev.value === '++' || prev.value === '--');
    return false;
  };

  while (i < n) {
    const c = src[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let e = src.indexOf('\n', i);
      if (e < 0) e = n;
      comments.push({ text: src.slice(i, e), line: lineAt(i) });
      i = e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let e = src.indexOf('*/', i + 2);
      e = e < 0 ? n : e + 2;
      comments.push({ text: src.slice(i, e), line: lineAt(i) });
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = skipQuoted(i);
      push('string', i, e, unescape(src.slice(i + 1, Math.max(i + 1, e - 1))));
      i = e;
      continue;
    }
    if (c === '`') {
      const [e, text] = skipTemplate(i);
      push('template', i, e, text);
      i = e;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j] ?? '')) j++;
      push('ident', i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j] ?? '')) j++;
      push('number', i, j);
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j] ?? '')) j++;
      push('regex', i, j);
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (PUNCT3.has(three)) {
      push('punct', i, i + 3);
      i += 3;
    } else if (PUNCT2.has(two) && !(two === '?.' && /[0-9]/.test(src[i + 2] ?? ''))) {
      push('punct', i, i + 2);
      i += 2;
    } else {
      push('punct', i, i + 1);
      i++;
    }
  }

  const match = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  tokens.forEach((t, k) => {
    if (t.kind !== 'punct') return;
    if (t.value === '(' || t.value === '[' || t.value === '{') stack.push(k);
    else if (t.value in pairs) {
      // Pop to the nearest opener of the right kind, so one stray bracket does not shift every later pair.
      for (let s = stack.length - 1; s >= 0; s--) {
        const o = stack[s] as number;
        if (tokens[o]?.value === pairs[t.value]) {
          match[o] = k;
          match[k] = o;
          stack.length = s;
          break;
        }
      }
    }
  });

  const scanned: ScannedSource = { src, tokens, comments, match, declarations: [] };
  scanned.declarations = findDeclarations(scanned);
  return scanned;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

/** The token at `i`, or an `eof` token past either end. */
export function tok(s: ScannedSource, i: number): Token {
  return s.tokens[i] ?? EOF;
}

export function isPunct(s: ScannedSource, i: number, value: string): boolean {
  const t = s.tokens[i];
  return t !== undefined && t.kind === 'punct' && t.value === value;
}

export function isIdent(s: ScannedSource, i: number, value?: string): boolean {
  const t = s.tokens[i];
  return t !== undefined && t.kind === 'ident' && (value === undefined || t.value === value);
}

/** The partner of the bracket at `i`, or -1. */
export function partner(s: ScannedSource, i: number): number {
  return s.match[i] ?? -1;
}

const MODIFIERS = new Set([
  'export', 'default', 'declare', 'abstract', 'static', 'private', 'public', 'protected', 'readonly', 'async',
  'override', 'get', 'set', 'const',
]);

/** The decorators written before the declaration whose first non-modifier token is at `i`. */
export function decoratorsBefore(s: ScannedSource, i: number): Decorator[] {
  const out: Decorator[] = [];
  let j = i - 1;
  for (;;) {
    while (j >= 0 && isIdent(s, j) && MODIFIERS.has(tok(s, j).value) && !isPunct(s, j - 1, '@')) j--;
    if (isPunct(s, j, ')')) {
      const open = partner(s, j);
      if (open > 1 && isIdent(s, open - 1) && isPunct(s, open - 2, '@')) {
        out.unshift({ name: tok(s, open - 1).value, argsOpen: open });
        j = open - 3;
        continue;
      }
      break;
    }
    if (isIdent(s, j) && isPunct(s, j - 1, '@')) {
      out.unshift({ name: tok(s, j).value });
      j -= 2;
      continue;
    }
    break;
  }
  return out;
}

/** The index of the first `{` at the current nesting level from `i`, stopping at `;` (returns -1). */
function bodyOpenFrom(s: ScannedSource, i: number, limit: number): number {
  for (let j = i; j < limit; j++) {
    const t = tok(s, j);
    if (t.kind !== 'punct') continue;
    if (t.value === '{') return j;
    if (t.value === ';' || t.value === '}' || t.value === '=') return -1;
    if (t.value === '(' || t.value === '[') {
      const p = partner(s, j);
      if (p < 0) return -1;
      j = p;
    }
  }
  return -1;
}

function findDeclarations(s: ScannedSource): Declaration[] {
  const out: Declaration[] = [];
  const n = s.tokens.length;
  for (let i = 0; i < n; i++) {
    const t = tok(s, i);
    if (t.kind !== 'ident') continue;
    if (isPunct(s, i - 1, '.')) continue;
    let kind: Declaration['kind'] | undefined;
    if (t.value === 'struct' || t.value === 'class' || t.value === 'enum' || t.value === 'namespace') kind = t.value;
    else if (t.value === 'function') kind = 'function';
    if (kind && isIdent(s, i + 1)) {
      const open = bodyOpenFrom(s, i + 2, n);
      const close = open >= 0 ? partner(s, open) : -1;
      if (close < 0) continue;
      out.push({
        kind,
        name: tok(s, i + 1).value,
        decorators: decoratorsBefore(s, i),
        nameIndex: i + 1,
        line: tok(s, i + 1).line,
        bodyOpen: open,
        bodyClose: close,
      });
      continue;
    }
    // `const Routes = { DETAIL: 'Detail' }` (an object of constants), optionally typed.
    if ((t.value === 'const' || t.value === 'let') && isIdent(s, i + 1)) {
      let j = i + 2;
      if (isPunct(s, j, ':')) {
        while (j < n && !isPunct(s, j, '=') && !isPunct(s, j, ';')) j++;
      }
      if (isPunct(s, j, '=') && isPunct(s, j + 1, '{')) {
        const close = partner(s, j + 1);
        if (close > 0) {
          out.push({
            kind: 'object',
            name: tok(s, i + 1).value,
            decorators: [],
            nameIndex: i + 1,
            line: tok(s, i + 1).line,
            bodyOpen: j + 1,
            bodyClose: close,
          });
        }
      }
    }
  }
  return out;
}

const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor']);

/** The methods declared directly in a struct or class body. */
export function findMethods(s: ScannedSource, decl: Declaration): Method[] {
  const out: Method[] = [];
  for (let i = decl.bodyOpen + 1; i < decl.bodyClose; i++) {
    const t = tok(s, i);
    if (t.kind === 'punct' && (t.value === '{' || t.value === '(' || t.value === '[')) {
      const p = partner(s, i);
      if (p > i) i = p;
      continue;
    }
    if (t.kind !== 'ident' || NOT_METHOD.has(t.value) || isPunct(s, i - 1, '.') || isPunct(s, i - 1, '@')) continue;
    let j = i + 1;
    if (isPunct(s, j, '<')) {
      while (j < decl.bodyClose && !isPunct(s, j, '>')) j++;
      j++;
    }
    if (!isPunct(s, j, '(')) continue;
    const close = partner(s, j);
    if (close < 0) continue;
    let open = -1;
    if (isPunct(s, close + 1, '{')) open = close + 1;
    else if (isPunct(s, close + 1, ':')) open = bodyOpenFrom(s, close + 2, decl.bodyClose);
    if (open < 0) {
      i = close;
      continue;
    }
    const end = partner(s, open);
    if (end < 0) break;
    out.push({ name: t.value, decorators: decoratorsBefore(s, i), nameIndex: i, line: t.line, bodyOpen: open, bodyClose: end });
    i = end;
  }
  return out;
}

/** The source text of the tokens `from..to` (inclusive), with its original spacing. */
export function sourceText(s: ScannedSource, from: number, to: number): string {
  const a = tok(s, from);
  const b = tok(s, to);
  if (a.kind === 'eof' || b.kind === 'eof' || to < from) return '';
  return s.src.slice(a.start, b.end).replace(/\s+/g, ' ');
}
