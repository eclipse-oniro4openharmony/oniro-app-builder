/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/ui/layout/xpath-finder.ts`), Copyright (c) 2026 Huawei
 * Device Co., Ltd., licensed under the MIT License. See the repository-root NOTICE.
 *
 * Kept from upstream: the `xpath=` selector form and its element model — each
 * layout node is an element named after its component type (`node` when it has
 * none) whose XML attributes are the layout attributes. Changed: upstream
 * serialises the raw dump to XML and runs full XPath 1.0 through `@xmldom/xmldom`
 * and `xpath`; this file evaluates a documented subset directly over the pruned
 * tree `dump layout` prints, with no dependency, and rejects anything outside it
 * with a parse error instead of a wrong answer.
 */
import type { FlatLayoutNode, LayoutNode } from './dump.js';
import {
  SELECTOR_KEYS,
  SelectorParseError,
  indexLayout,
  resolveSelectorKey,
  selectorAttribute,
  type IndexedLayoutNode,
  type SelectorKey,
} from './layoutQuery.js';

/*
 * The supported subset (anything else is a SelectorParseError):
 *
 *   path        := ('/' | '//') step (('/' | '//') step)*
 *                | '(' path ')' predicate* (('/' | '//') step)*
 *   step        := (Name | '*') predicate* | '.' | '..'
 *   predicate   := '[' expr ']'          a number n keeps the n-th (1-based) node of the step
 *   expr        := and ('or' and)*
 *   and         := cmp ('and' cmp)*
 *   cmp         := primary (('=' | '!=' | '<' | '<=' | '>' | '>=') primary)?
 *   primary     := '@' attr | 'text()' | String | Number | '(' expr ')'
 *                | contains(a, b) | starts-with(a, b) | ends-with(a, b) | not(x)
 *                | position() | last()
 *
 * Element names are component types (`Button`, `TextInput`, …; `node` when
 * untyped); attributes are the selector keys in {@link SELECTOR_KEYS}
 * (`text()` is `@text`). `[n]` is positional among the step's matches under one
 * parent, as in XPath: `//Button[1]` is every Button that is its parent's first
 * Button; `(//Button)[1]` is the first Button on screen.
 */

type Expr =
  | { k: 'or' | 'and'; a: Expr; b: Expr }
  | { k: 'cmp'; op: CmpOp; a: Expr; b: Expr }
  | { k: 'attr'; key: SelectorKey }
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'fn'; name: FnName; args: Expr[] };

type CmpOp = '=' | '!=' | '<' | '<=' | '>' | '>=';
type FnName = 'contains' | 'starts-with' | 'ends-with' | 'not' | 'position' | 'last';

const FN_ARITY: Readonly<Record<FnName, number>> = {
  contains: 2,
  'starts-with': 2,
  'ends-with': 2,
  not: 1,
  position: 0,
  last: 0,
};

type Step =
  | { axis: 'child' | 'descendant'; name: string; predicates: Expr[] }
  | { axis: 'self' | 'descendant-or-self' | 'parent' };

/** A parsed XPath expression (see {@link parseXPath}). */
export interface XPathExpression {
  /** The source text. */
  readonly source: string;
  /** Where evaluation starts: the document, or a parenthesised path filtered by predicates. */
  readonly start: { group: XPathExpression; predicates: Expr[] } | 'root';
  readonly steps: readonly Step[];
}

type Tok =
  | { t: '/' | '//' | '[' | ']' | '(' | ')' | ',' | '@' | '*' | '.' | '..'; pos: number }
  | { t: 'op'; v: CmpOp; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'str'; v: string; pos: number }
  | { t: 'num'; v: number; pos: number }
  | { t: 'eof'; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new SelectorParseError(msg, i, src);
  };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const pos = i;
    const two = src.slice(i, i + 2);
    if (two === '//' || two === '..') {
      out.push({ t: two, pos });
      i += 2;
    } else if (two === '!=' || two === '<=' || two === '>=') {
      out.push({ t: 'op', v: two, pos });
      i += 2;
    } else if ('/[](),@*'.includes(c)) {
      out.push({ t: c as '/', pos });
      i++;
    } else if (c === '=' || c === '<' || c === '>') {
      out.push({ t: 'op', v: c, pos });
      i++;
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) fail('unterminated string');
      out.push({ t: 'str', v: src.slice(i + 1, end), pos });
      i = end + 1;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), pos });
      i += m[0].length;
    } else if (c === '.') {
      out.push({ t: '.', pos });
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))!;
      out.push({ t: 'name', v: m[0], pos });
      i += m[0].length;
    } else if (c === '|') {
      fail('unions (|) are not supported; run one expression per selector');
    } else if (c === ':') {
      fail('axis names (child::, ancestor::, …) are not supported; use / , // or ..');
    } else {
      fail(`unexpected character "${c}"`);
    }
  }
  out.push({ t: 'eof', pos: src.length });
  return out;
}

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly src: string,
  ) {}

  private peek(): Tok {
    return this.toks[this.i]!;
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private fail(msg: string, tok: Tok = this.peek()): never {
    throw new SelectorParseError(msg, tok.pos, this.src);
  }
  private expect(t: Tok['t'], what: string): Tok {
    const tok = this.peek();
    if (tok.t !== t) this.fail(`expected ${what}`);
    return this.next();
  }
  private isName(v: string): boolean {
    const tok = this.peek();
    return tok.t === 'name' && tok.v === v;
  }

  parseTop(): XPathExpression {
    const path = this.parsePath();
    if (this.peek().t !== 'eof') this.fail('unexpected trailing input');
    return path;
  }

  private parsePath(): XPathExpression {
    const startTok = this.peek();
    let start: XPathExpression['start'] = 'root';
    if (startTok.t === '(') {
      this.next();
      const group = this.parsePath();
      this.expect(')', "')'");
      start = { group, predicates: this.parsePredicates() };
    } else if (startTok.t !== '/' && startTok.t !== '//') {
      this.fail('an XPath starts with / or // (for example //Button[@text="OK"]), or with a parenthesised path');
    }
    const steps: Step[] = [];
    for (;;) {
      const sep = this.peek();
      if (sep.t !== '/' && sep.t !== '//') break;
      this.next();
      steps.push(this.parseStep(sep.t === '//'));
    }
    if (start === 'root' && steps.length === 0) this.fail('expected a step');
    return { source: this.src, start, steps };
  }

  private parseStep(descendant: boolean): Step {
    const tok = this.peek();
    if (tok.t === '.') {
      this.next();
      return { axis: descendant ? 'descendant-or-self' : 'self' };
    }
    if (tok.t === '..') {
      if (descendant) this.fail("'//..' is not supported");
      this.next();
      return { axis: 'parent' };
    }
    if (tok.t === '@') this.fail('attribute steps are not supported; test the attribute in a predicate: //*[@text="OK"]');
    let name: string;
    if (tok.t === '*') name = '*';
    else if (tok.t === 'name') name = tok.v;
    else this.fail('expected an element name, *, . or ..');
    this.next();
    if (this.peek().t === '(') this.fail(`node tests such as ${name}() are not supported`);
    return { axis: descendant ? 'descendant' : 'child', name, predicates: this.parsePredicates() };
  }

  private parsePredicates(): Expr[] {
    const out: Expr[] = [];
    while (this.peek().t === '[') {
      this.next();
      out.push(this.parseOr());
      this.expect(']', "']'");
    }
    return out;
  }

  private parseOr(): Expr {
    let a = this.parseAnd();
    while (this.isName('or')) {
      this.next();
      a = { k: 'or', a, b: this.parseAnd() };
    }
    return a;
  }

  private parseAnd(): Expr {
    let a = this.parseCmp();
    while (this.isName('and')) {
      this.next();
      a = { k: 'and', a, b: this.parseCmp() };
    }
    return a;
  }

  private parseCmp(): Expr {
    const a = this.parsePrimary();
    const tok = this.peek();
    if (tok.t !== 'op') return a;
    this.next();
    return { k: 'cmp', op: tok.v, a, b: this.parsePrimary() };
  }

  private parsePrimary(): Expr {
    const tok = this.next();
    switch (tok.t) {
      case '(': {
        const e = this.parseOr();
        this.expect(')', "')'");
        return e;
      }
      case '@': {
        const name = this.peek();
        if (name.t !== 'name') this.fail('expected an attribute name after @');
        this.next();
        const key = resolveSelectorKey(name.v);
        if (!key) this.fail(`unknown attribute @${name.v}; known: ${SELECTOR_KEYS.map((k) => `@${k}`).join(', ')}`, name);
        return { k: 'attr', key };
      }
      case 'str':
        return { k: 'str', v: tok.v };
      case 'num':
        return { k: 'num', v: tok.v };
      case 'name': {
        if (this.peek().t !== '(') {
          this.fail(`paths inside predicates are not supported (got "${tok.v}"); test attributes with @name`, tok);
        }
        this.next();
        const args: Expr[] = [];
        if (this.peek().t !== ')') {
          args.push(this.parseOr());
          while (this.peek().t === ',') {
            this.next();
            args.push(this.parseOr());
          }
        }
        this.expect(')', "')'");
        if (tok.v === 'text') {
          if (args.length > 0) this.fail('text() takes no arguments', tok);
          return { k: 'attr', key: 'text' };
        }
        if (!(tok.v in FN_ARITY)) {
          this.fail(
            `unsupported function ${tok.v}(); supported: ${[...Object.keys(FN_ARITY), 'text'].map((f) => `${f}()`).join(', ')}`,
            tok,
          );
        }
        const name = tok.v as FnName;
        if (args.length !== FN_ARITY[name]) this.fail(`${name}() takes ${FN_ARITY[name]} argument(s)`, tok);
        return { k: 'fn', name, args };
      }
      default:
        return this.fail('expected an attribute, a string, a number or a function', tok);
    }
  }
}

/** Parse an XPath expression in the supported subset; throws {@link SelectorParseError}. */
export function parseXPath(source: string): XPathExpression {
  if (source.trim() === '') throw new SelectorParseError('empty XPath expression', 0, source);
  return new Parser(tokenize(source), source).parseTop();
}

type Value = string | number | boolean | null;

interface Ctx {
  node: IndexedLayoutNode;
  position: number;
  size: number;
}

const toStr = (v: Value): string => (v === null ? '' : String(v));
const toBool = (v: Value): boolean => (typeof v === 'string' ? v.length > 0 : typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : !!v);

function compare(op: CmpOp, a: Value, b: Value): boolean {
  // A missing attribute is an empty node-set: no comparison with it holds.
  if (a === null || b === null) return false;
  if (op === '=' || op === '!=') {
    let eq: boolean;
    if (typeof a === 'boolean' || typeof b === 'boolean') eq = toBool(a) === toBool(b);
    else if (typeof a === 'number' || typeof b === 'number') eq = Number(a) === Number(b);
    else eq = a === b;
    return op === '=' ? eq : !eq;
  }
  const x = Number(a);
  const y = Number(b);
  switch (op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    default:
      return x >= y;
  }
}

function evalExpr(e: Expr, ctx: Ctx): Value {
  switch (e.k) {
    case 'or':
      return toBool(evalExpr(e.a, ctx)) || toBool(evalExpr(e.b, ctx));
    case 'and':
      return toBool(evalExpr(e.a, ctx)) && toBool(evalExpr(e.b, ctx));
    case 'cmp':
      return compare(e.op, evalExpr(e.a, ctx), evalExpr(e.b, ctx));
    case 'attr':
      return ctx.node.empty ? null : selectorAttribute(ctx.node.flat, e.key) ?? null;
    case 'str':
      return e.v;
    case 'num':
      return e.v;
    case 'fn': {
      const arg = (i: number): Value => evalExpr(e.args[i]!, ctx);
      switch (e.name) {
        case 'contains':
          return toStr(arg(0)).includes(toStr(arg(1)));
        case 'starts-with':
          return toStr(arg(0)).startsWith(toStr(arg(1)));
        case 'ends-with':
          return toStr(arg(0)).endsWith(toStr(arg(1)));
        case 'not':
          return !toBool(arg(0));
        case 'position':
          return ctx.position;
        case 'last':
          return ctx.size;
      }
    }
  }
}

/** Keep the nodes each predicate accepts; a numeric predicate keeps the node at that 1-based position. */
function applyPredicates(nodes: IndexedLayoutNode[], predicates: readonly Expr[]): IndexedLayoutNode[] {
  let cur = nodes;
  for (const p of predicates) {
    cur = cur.filter((node, i) => {
      const v = evalExpr(p, { node, position: i + 1, size: cur.length });
      return typeof v === 'number' ? v === i + 1 : toBool(v);
    });
  }
  return cur;
}

const elementName = (n: IndexedLayoutNode): string => n.flat.type ?? 'node';

function descendantsOrSelf(contexts: readonly IndexedLayoutNode[]): IndexedLayoutNode[] {
  const seen = new Set<IndexedLayoutNode>();
  const stack = [...contexts].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return [...seen];
}

function inDocumentOrder(nodes: Iterable<IndexedLayoutNode>): IndexedLayoutNode[] {
  return [...new Set(nodes)].sort((a, b) => a.order - b.order);
}

function evalStep(contexts: IndexedLayoutNode[], step: Step): IndexedLayoutNode[] {
  switch (step.axis) {
    case 'self':
      return contexts;
    case 'parent':
      return inDocumentOrder(contexts.flatMap((n) => (n.parent ? [n.parent] : [])));
    case 'descendant-or-self':
      return inDocumentOrder(descendantsOrSelf(contexts));
    default: {
      // `//name` is `/descendant-or-self::node()/name`: predicates count per parent.
      const parents = step.axis === 'descendant' ? descendantsOrSelf(contexts) : contexts;
      const out: IndexedLayoutNode[] = [];
      for (const p of parents) {
        const named = p.children.filter((c) => step.name === '*' || elementName(c) === step.name);
        out.push(...applyPredicates(named, step.predicates));
      }
      return inDocumentOrder(out);
    }
  }
}

function evalPath(doc: IndexedLayoutNode, expr: XPathExpression): IndexedLayoutNode[] {
  let cur: IndexedLayoutNode[];
  if (expr.start === 'root') cur = [doc];
  else cur = applyPredicates(evalPath(doc, expr.start.group), expr.start.predicates);
  for (const step of expr.steps) cur = evalStep(cur, step);
  return cur;
}

/**
 * Evaluate an XPath expression (source text or {@link parseXPath} result) over
 * a pruned layout tree. Returns the matching nodes in paint order, tagged with
 * their window; bare containers are never returned.
 */
export function evaluateXPath(tree: LayoutNode, expr: XPathExpression | string): FlatLayoutNode[] {
  const parsed = typeof expr === 'string' ? parseXPath(expr) : expr;
  const root = indexLayout(tree);
  // The document node above the tree root, so `/node` and `/*` select the root as in XPath.
  const doc: IndexedLayoutNode = { flat: {}, parent: null, children: [root], order: -1, empty: true };
  root.parent = doc;
  return evalPath(doc, parsed)
    .filter((n) => n !== doc && !n.empty)
    .map((n) => n.flat);
}
