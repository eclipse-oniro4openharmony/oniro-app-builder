/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/ui/layout/selector-parser.ts`), Copyright (c) 2026 Huawei
 * Device Co., Ltd., licensed under the MIT License. See the repository-root NOTICE.
 *
 * Kept from upstream: the selector grammar (comma-separated `key<op>value`
 * clauses, the `=`, `*=`, `^=`, `$=` and `/=` operators, quoted values with
 * backslash escapes, `/flags` on regex values, the `[n]` / `[-n]` / `[last]`
 * index suffix, duplicate-key rejection) and the scanner it is parsed with.
 * Changed: keys are a fixed set read off the pruned tree `dump layout` prints
 * (an unknown key is a parse error, not a warning); `xpath=` expressions parse
 * through ./xpath.ts; `selectorFor` and `formatSelector` are new.
 */
import { OniroError } from '../ports/errors.js';
import type { FlatLayoutNode, LayoutNode } from './dump.js';
import {
  SELECTOR_KEYS,
  SelectorParseError,
  allIndexed,
  indexLayout,
  resolveSelectorKey,
  selectorAttribute,
  type SelectorKey,
} from './layoutQuery.js';
import { evaluateXPath, parseXPath, type XPathExpression } from './xpath.js';


/** `=` equals, `*=` contains, `^=` starts with, `$=` ends with, `/=` matches a regular expression. */
export type SelectorOperator = '=' | '*=' | '^=' | '$=' | '/=';

export interface SelectorClause {
  key: SelectorKey;
  op: SelectorOperator;
  value: string;
  /** Regular-expression flags, for `/=` (`text/=^sign/i`). */
  flags?: string;
}

/** `type=Button,text*=Sign[1]`: every clause must hold; `index` picks one match. */
export interface DslSelector {
  kind: 'dsl';
  clauses: SelectorClause[];
  /** 0-based index into the matches in paint order; negative counts from the end (`[last]` is -1). */
  index?: number;
  raw: string;
}

/** `xpath=//Button[@text="OK"]`. */
export interface XPathSelector {
  kind: 'xpath';
  xpath: XPathExpression;
  raw: string;
}

/** A parsed `--selector` expression. */
export type ElementSelector = DslSelector | XPathSelector;

const XPATH_PREFIX = 'xpath=';
const TWO_CHAR_OPS: readonly SelectorOperator[] = ['*=', '^=', '$=', '/='];
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const WS = /\s/;
const REGEX_FLAGS_TAIL = /^(.*)\/([imsu]+)$/s;

class Scanner {
  pos = 0;
  constructor(readonly input: string) {}
  eof(): boolean {
    return this.pos >= this.input.length;
  }
  peek(): string {
    return this.input[this.pos] ?? '';
  }
  next(): string {
    return this.input[this.pos++] ?? '';
  }
  startsWith(s: string): boolean {
    return this.input.startsWith(s, this.pos);
  }
  fail(msg: string): never {
    throw new SelectorParseError(msg, this.pos, this.input);
  }
}

function skipWs(sc: Scanner): void {
  while (!sc.eof() && WS.test(sc.peek())) sc.next();
}

function parseKey(sc: Scanner): SelectorKey {
  const start = sc.pos;
  if (!IDENT_START.test(sc.peek())) sc.fail('expected an attribute key');
  while (!sc.eof() && IDENT_PART.test(sc.peek())) sc.next();
  const name = sc.input.slice(start, sc.pos);
  const key = resolveSelectorKey(name);
  if (!key) {
    sc.pos = start;
    sc.fail(`unknown key "${name}"; known keys: ${SELECTOR_KEYS.join(', ')}`);
  }
  return key;
}

function parseOp(sc: Scanner, key: string): SelectorOperator {
  for (const op of TWO_CHAR_OPS) {
    if (sc.startsWith(op)) {
      sc.pos += op.length;
      return op;
    }
  }
  if (sc.peek() === '=') {
    sc.next();
    return '=';
  }
  return sc.fail(`expected an operator (=, *=, ^=, $=, /=) after "${key}"`);
}

const isQuote = (c: string): boolean => c === '"' || c === "'";

function parseQuoted(sc: Scanner): string {
  const quote = sc.next();
  let out = '';
  while (!sc.eof()) {
    const c = sc.next();
    if (c === '\\') {
      if (sc.eof()) sc.fail('dangling escape in a quoted value');
      out += sc.next();
    } else if (c === quote) {
      return out;
    } else {
      out += c;
    }
  }
  return sc.fail('unterminated quoted value');
}

function parseBare(sc: Scanner): string {
  let out = '';
  while (!sc.eof()) {
    const c = sc.peek();
    if (c === ',' || c === '[' || isQuote(c)) break;
    if (WS.test(c)) {
      // Inner spaces belong to the value ("text=Sign in"); trailing ones do not.
      let j = sc.pos + 1;
      while (j < sc.input.length && WS.test(sc.input[j]!)) j++;
      const after = sc.input[j] ?? '';
      if (after === '' || after === ',' || after === '[' || isQuote(after)) break;
      out += sc.next();
      continue;
    }
    if (c === '\\') {
      sc.next();
      if (sc.eof()) sc.fail('dangling escape in a value');
      out += sc.next();
      continue;
    }
    out += sc.next();
  }
  return out;
}

function parseClause(sc: Scanner): SelectorClause {
  skipWs(sc);
  const key = parseKey(sc);
  skipWs(sc);
  const op = parseOp(sc, key);
  skipWs(sc);
  if (sc.eof() || sc.peek() === ',' || sc.peek() === '[') sc.fail(`missing value for "${key}"`);
  let value = isQuote(sc.peek()) ? parseQuoted(sc) : parseBare(sc);
  const clause: SelectorClause = { key, op, value };
  if (op === '/=') {
    const m = REGEX_FLAGS_TAIL.exec(value);
    if (m) {
      value = m[1]!;
      clause.value = value;
      clause.flags = m[2]!;
    }
    try {
      new RegExp(value, clause.flags);
    } catch (e) {
      sc.fail(`invalid regular expression "${value}": ${(e as Error).message}`);
    }
  }
  return clause;
}

function parseIndex(sc: Scanner): number {
  let token = '';
  while (!sc.eof() && sc.peek() !== ']') token += sc.next();
  token = token.trim();
  if (token === 'last') return -1;
  if (/^-?\d+$/.test(token)) return parseInt(token, 10);
  return sc.fail(`invalid index "${token}" (expected n, -n or last)`);
}

function parseDsl(input: string): DslSelector {
  const sc = new Scanner(input);
  skipWs(sc);
  if (sc.eof()) sc.fail('empty selector');
  const clauses: SelectorClause[] = [parseClause(sc)];
  for (;;) {
    skipWs(sc);
    if (sc.peek() !== ',') break;
    sc.next();
    skipWs(sc);
    if (sc.eof() || sc.peek() === ',') sc.fail('expected a clause after the comma');
    clauses.push(parseClause(sc));
  }
  const seen = new Set<SelectorKey>();
  for (const c of clauses) {
    if (seen.has(c.key)) sc.fail(`"${c.key}" appears twice`);
    seen.add(c.key);
  }
  const out: DslSelector = { kind: 'dsl', clauses, raw: input };
  skipWs(sc);
  if (sc.peek() === '[') {
    sc.next();
    out.index = parseIndex(sc);
    if (sc.peek() !== ']') sc.fail("expected ']' after the index");
    sc.next();
    skipWs(sc);
  }
  if (!sc.eof()) sc.fail(`unexpected trailing input "${sc.input.slice(sc.pos)}"`);
  return out;
}

/**
 * Parse a `--selector` expression: `xpath=<expr>` (see ./xpath.ts for the
 * subset), or the attribute DSL `key<op>value[,key<op>value…][n]` with keys
 * from {@link SELECTOR_KEYS}. Throws {@link SelectorParseError}.
 */
export function parseSelector(input: string): ElementSelector {
  const trimmed = input.trimStart();
  if (trimmed.startsWith(XPATH_PREFIX)) {
    const source = trimmed.slice(XPATH_PREFIX.length);
    return { kind: 'xpath', xpath: parseXPath(source), raw: input };
  }
  return parseDsl(input);
}

/** Each `/=` clause's compiled pattern, so matching a large layout compiles it once. */
const clauseRegex = new WeakMap<SelectorClause, RegExp>();

/** Whether one clause holds on a node. String comparisons are case-sensitive. */
export function clauseMatches(n: FlatLayoutNode, clause: SelectorClause): boolean {
  const v = selectorAttribute(n, clause.key);
  if (v === undefined) return false;
  switch (clause.op) {
    case '=':
      return v === clause.value;
    case '*=':
      return v.includes(clause.value);
    case '^=':
      return v.startsWith(clause.value);
    case '$=':
      return v.endsWith(clause.value);
    case '/=': {
      let re = clauseRegex.get(clause);
      if (!re) clauseRegex.set(clause, (re = new RegExp(clause.value, clause.flags)));
      return re.test(v);
    }
  }
}

/**
 * Every node of a pruned layout tree matching `selector`, in paint order,
 * tagged with its window. The DSL index suffix is not applied here (callers
 * pick with it); bare containers never match.
 */
export function matchSelector(tree: LayoutNode, selector: ElementSelector): FlatLayoutNode[] {
  if (selector.kind === 'xpath') return evaluateXPath(tree, selector.xpath);
  return allIndexed(indexLayout(tree))
    .filter((n) => !n.empty && selector.clauses.every((c) => clauseMatches(n.flat, c)))
    .map((n) => n.flat);
}

/** Quote a DSL value when it would not survive bare (separators, quotes, edge spaces, escapes). */
function formatValue(v: string): string {
  if (v !== '' && !/[,[\]"'\\]/.test(v) && v.trim() === v) return v;
  return `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Render DSL clauses (and an index) back into `--selector` text that {@link parseSelector} reads back. */
export function formatSelector(clauses: readonly SelectorClause[], index?: number): string {
  const body = clauses
    .map((c) => {
      const value = c.op === '/=' && c.flags ? `${c.value}/${c.flags}` : c.value;
      return `${c.key}${c.op}${formatValue(value)}`;
    })
    .join(',');
  return index === undefined ? body : `${body}[${index}]`;
}

/** The recorded attributes of an element, as `dump layout` / `wait --json` print them. */
export type RecordedElement = Partial<FlatLayoutNode>;

// The attributes that identify an element across runs, most stable first.
// State flags (focused, checked, …) change as the app runs and are left out.
const STABLE_KEYS: readonly SelectorKey[] = ['id', 'key', 'text', 'desc', 'hint'];

const IDENTITY_FIELDS = ['type', 'id', 'key', 'text', 'desc', 'hint'] as const;

/** The node in `nodes` the recorded element is: same identity fields, nearest center as tie-break. */
function locateRecorded(nodes: FlatLayoutNode[], element: RecordedElement): FlatLayoutNode | undefined {
  const fields = IDENTITY_FIELDS.filter((f) => element[f] !== undefined);
  const same = nodes.filter((n) => fields.every((f) => n[f] === element[f]) && (element.windowId === undefined || n.windowId === element.windowId));
  if (same.length <= 1 || !element.c) return same[0];
  const [x, y] = element.c;
  const dist = (n: FlatLayoutNode): number => (n.c ? (n.c[0] - x) ** 2 + (n.c[1] - y) ** 2 : Infinity);
  return same.reduce((best, n) => (dist(n) < dist(best) ? n : best));
}

/**
 * The most specific stable `--selector` for a recorded element: the first of
 * `type` plus one of id, key, text, desc or hint (in that order of
 * stability), then type plus every stable attribute it has, that matches
 * exactly this element in `tree`; failing that, the full clause set with the
 * element's `[n]` index among its matches. Exact (`=`) clauses only, so the
 * selector does not drift onto similar elements. The element is found in
 * `tree` by its type, id, key and labels (nearest `c` breaks a tie); throws
 * when it is not there. Pure — the replay side of `record` (O-9) builds on it.
 */
export function selectorFor(tree: LayoutNode, element: RecordedElement): string {
  const nodes = allIndexed(indexLayout(tree))
    .filter((n) => !n.empty)
    .map((n) => n.flat);
  const target = locateRecorded(nodes, element);
  if (!target) throw new OniroError('The recorded element is not in this layout.');

  const clause = (key: SelectorKey): SelectorClause | undefined => {
    const value = selectorAttribute(target, key);
    return value === undefined || value === '' ? undefined : { key, op: '=', value };
  };
  const typeClause = clause('type');
  const withType = (cs: SelectorClause[]): SelectorClause[] => (typeClause ? [typeClause, ...cs] : cs);
  // `key` duplicates `id` when the pruned tree dropped an equal key.
  const stable = STABLE_KEYS.filter((k) => !(k === 'key' && target.key === undefined))
    .map(clause)
    .filter((c): c is SelectorClause => c !== undefined);

  const candidates: SelectorClause[][] = stable.map((c) => withType([c]));
  if (stable.length > 1) candidates.push(withType(stable));
  // The same nodes in the same order as matchSelector, so the index below is the one replay resolves.
  const matchesOf = (cs: SelectorClause[]): FlatLayoutNode[] => nodes.filter((n) => cs.every((c) => clauseMatches(n, c)));
  for (const cs of candidates) {
    const m = matchesOf(cs);
    if (m.length === 1 && m[0] === target) return formatSelector(cs);
  }
  const all = withType(stable);
  if (all.length === 0) throw new OniroError('The recorded element has no type, id or label to select it by.');
  return formatSelector(all, matchesOf(all).indexOf(target));
}
