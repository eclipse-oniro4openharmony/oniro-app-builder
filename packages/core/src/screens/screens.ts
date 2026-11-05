import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import { OniroError } from '../ports/errors.js';
import { listModules } from '../project/listModules.js';
import {
  findMethods,
  isIdent,
  isPunct,
  partner,
  scanEts,
  sourceText,
  tok,
  type Declaration,
  type Method,
  type ScannedSource,
} from './etsScanner.js';

export interface ScreenPage {
  /**
   * The name a route uses to reach the page: the `main_pages.json` entry (`pages/Index`) for an `@Entry` page
   * (its `routeName` for a named route), the route name for a `NavDestination` (`Detail`), the struct name for a
   * `NavDestination` struct no route registers.
   */
  name: string;
  module: string;
  /** Project-relative path of the file declaring the page's component (or route-map builder). */
  file: string;
  line: number;
  /** The struct rendered as the page, when there is one. */
  component: string | null;
  /** The component is decorated `@Entry`. */
  entry: boolean;
  kind: 'entry' | 'navDestination';
  /** Listed in `main_pages.json`, a route map, a `.navDestination()` builder, or an `@Entry({ routeName })`. */
  registered: boolean;
  /**
   * Component calls the page renders, through its custom components and `@Builder`s, excluding layout
   * containers (`Column`, `Row`, `Stack`, `List`, `Navigation`, `NavDestination`, ...) and `Blank`/`Divider`.
   * Each `ForEach`/`LazyForEach`/`Repeat` item template and each `if` branch counts once.
   */
  contentNodes: number;
  /** Distinct literal route targets pushed from the page's component or the custom components it renders. */
  routesOut: string[];
}

export interface ScreenRoute {
  /** The page whose component holds the call site, else the enclosing struct, class or function. */
  from: string;
  /** The target: a `pages/...` url, a NavDestination route name, or the source of a non-literal argument. */
  to: string;
  file: string;
  line: number;
  /** The call: `pushUrl`, `replaceUrl`, `pushNamedRoute`, `replaceNamedRoute`, `pushPath`, `pushPathByName`, `replacePath`, `replacePathByName`, `pushDestination`, `pushDestinationByName` or `loadContent`. */
  via: string;
  /** The target is not a string literal or a constant resolvable in the project (`to` is then its source text). */
  dynamic?: true;
}

export interface ScreenPlaceholder {
  file: string;
  line: number;
  text: string;
  /** `comment` (TODO/FIXME), `text` (a placeholder-like string literal), `resource` (such a string in string.json), `empty-build`, `no-content` (a page that renders only containers). */
  kind: 'comment' | 'text' | 'resource' | 'empty-build' | 'no-content';
}

export interface ScreensInventory {
  projectDir: string;
  modules: string[];
  pages: ScreenPage[];
  routes: ScreenRoute[];
  placeholders: ScreenPlaceholder[];
  /** Things the inventory could not resolve: a listed page whose file is missing, a route-map builder not found, ... */
  warnings: string[];
}

export interface ScreensOptions {
  projectDir: string;
}

/** Layout-only components: they arrange content but are not content. */
export const LAYOUT_COMPONENTS: ReadonlySet<string> = new Set([
  'Column', 'Row', 'Stack', 'Flex', 'RelativeContainer', 'GridRow', 'GridCol', 'Grid', 'GridItem', 'List', 'ListItem',
  'ListItemGroup', 'Scroll', 'Navigation', 'NavDestination', 'NavRouter', 'Tabs', 'TabContent', 'Swiper', 'WaterFlow',
  'FlowItem', 'SideBarContainer', 'ColumnSplit', 'RowSplit', 'Refresh', 'Stepper', 'StepperItem', 'FolderStack',
  'ArcList', 'ArcListItem', 'ArcSwiper', 'Blank', 'Divider',
]);

/** Route calls and where their target is: `{ url }`, `{ name }`, the first argument, or a NavPathInfo. A Map, so `toString` is not one. */
const ROUTE_CALLS = new Map<string, 'url' | 'name' | 'first' | 'pathInfo'>([
  ['pushUrl', 'url'],
  ['replaceUrl', 'url'],
  ['pushNamedRoute', 'name'],
  ['replaceNamedRoute', 'name'],
  ['pushPathByName', 'first'],
  ['replacePathByName', 'first'],
  ['pushDestinationByName', 'first'],
  ['pushPath', 'pathInfo'],
  ['replacePath', 'pathInfo'],
  ['pushDestination', 'pathInfo'],
  ['loadContent', 'first'],
]);

const PLACEHOLDER_TEXT =
  /\b(placeholder|lorem(?: ipsum)?|coming soon|tbd|not (?:yet )?implemented|under construction|hello world)\b/i;
const PLACEHOLDER_COMMENT = /\b(TODO|FIXME)\b/;

interface EtsFile {
  abs: string;
  rel: string;
  module: string;
  /** Path relative to the module's `src/main/ets`, without `.ets` (`pages/Index`). */
  etsPath: string;
  s: ScannedSource;
}

interface StructInfo {
  name: string;
  file: EtsFile;
  decl: Declaration;
  methods: Map<string, Method>;
}

interface FunctionInfo {
  name: string;
  file: EtsFile;
  decl: Declaration;
}

/** What rendering a block reaches: its content nodes and the structs it renders. */
interface Reach {
  nodes: number;
  structs: Set<StructInfo>;
  /** The first custom component called, the destination's component for a route builder. */
  first?: StructInfo;
}

class ProjectIndex {
  readonly structs = new Map<string, StructInfo[]>();
  readonly builders = new Map<string, FunctionInfo[]>();
  /** `NAME` and `Container.NAME` string constants. */
  readonly constants = new Map<string, string>();
  private readonly structMemo = new Map<StructInfo, Reach>();
  private readonly visiting = new Set<object>();

  constructor(readonly files: EtsFile[]) {
    for (const f of files) {
      for (const d of f.s.declarations) {
        if (d.kind === 'struct') {
          const methods = new Map(findMethods(f.s, d).map((m) => [m.name, m]));
          pushTo(this.structs, d.name, { name: d.name, file: f, decl: d, methods });
        } else if (d.kind === 'function' && d.decorators.some((x) => x.name === 'Builder')) {
          pushTo(this.builders, d.name, { name: d.name, file: f, decl: d });
        }
      }
      collectConstants(f.s, this.constants);
    }
  }

  /** The declaration of `name` nearest to `from`: same file, then same module, then anywhere. */
  pick<T extends { file: EtsFile }>(list: T[] | undefined, from: EtsFile): T | undefined {
    if (!list?.length) return undefined;
    return list.find((x) => x.file === from) ?? list.find((x) => x.file.module === from.module) ?? list[0];
  }

  structReach(st: StructInfo): Reach {
    const memo = this.structMemo.get(st);
    if (memo) return memo;
    const build = st.methods.get('build');
    if (!build || this.visiting.has(st)) return { nodes: 0, structs: new Set([st]) };
    this.visiting.add(st);
    const r = this.blockReach(st.file, build.bodyOpen + 1, build.bodyClose, st);
    this.visiting.delete(st);
    r.structs.add(st);
    const out: Reach = { nodes: r.nodes, structs: r.structs };
    this.structMemo.set(st, out);
    return out;
  }

  /** Walk the UI statements of tokens `[from, to)`: components, `if`/`else`, `ForEach`, `Repeat`, builder calls. */
  blockReach(file: EtsFile, from: number, to: number, owner: StructInfo | undefined): Reach {
    const s = file.s;
    const acc: Reach = { nodes: 0, structs: new Set() };
    const add = (r: Reach): void => {
      acc.nodes += r.nodes;
      for (const x of r.structs) acc.structs.add(x);
      if (!acc.first && r.first) acc.first = r.first;
    };
    const addBlock = (open: number): number => {
      const close = partner(s, open);
      if (close < 0) return to;
      add(this.blockReach(file, open + 1, close, owner));
      return close + 1;
    };
    /** Skip `.attr(...)` chains after a call ending before `j`. */
    const skipChain = (j: number): number => {
      while (j < to && (isPunct(s, j, '.') || isPunct(s, j, '?.')) && isIdent(s, j + 1) && isPunct(s, j + 2, '(')) {
        const close = partner(s, j + 2);
        if (close < 0) return to;
        j = close + 1;
      }
      return j;
    };
    /** The UI bodies of the arrow functions passed at the top level of the argument list `(open, close)`. */
    const arrowBodies = (open: number, close: number): void => {
      for (let k = open + 1; k < close; k++) {
        const t = tok(s, k);
        if (t.kind === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{')) {
          const p = partner(s, k);
          if (p > k) k = p;
          continue;
        }
        if (!isPunct(s, k, '=>')) continue;
        if (isPunct(s, k + 1, '{')) {
          k = addBlock(k + 1) - 1;
        } else {
          let e = k + 1;
          while (e < close && !isPunct(s, e, ',')) {
            const p = partner(s, e);
            e = p > e ? p + 1 : e + 1;
          }
          add(this.blockReach(file, k + 1, e, owner));
          k = e;
        }
      }
    };

    let i = from;
    while (i < to) {
      const t = tok(s, i);
      if (t.kind !== 'ident' || isPunct(s, i - 1, '.') || isPunct(s, i - 1, '?.')) {
        i++;
        continue;
      }
      if (t.value === 'if' && isPunct(s, i + 1, '(')) {
        let j = partner(s, i + 1) + 1;
        if (j <= 0) return acc;
        j = isPunct(s, j, '{') ? addBlock(j) : j;
        if (isIdent(s, j, 'else')) {
          j++;
          if (isPunct(s, j, '{')) j = addBlock(j);
        }
        i = j;
        continue;
      }
      if (t.value === 'this' && isPunct(s, i + 1, '.') && isIdent(s, i + 2) && isPunct(s, i + 3, '(')) {
        const m = owner?.methods.get(tok(s, i + 2).value);
        if (m && m.decorators.some((d) => d.name === 'Builder' || d.name === 'LocalBuilder') && !this.visiting.has(m)) {
          this.visiting.add(m);
          add(this.blockReach(file, m.bodyOpen + 1, m.bodyClose, owner));
          this.visiting.delete(m);
        }
        const close = partner(s, i + 3);
        i = close < 0 ? to : skipChain(close + 1);
        continue;
      }
      if (!isPunct(s, i + 1, '(')) {
        i++;
        continue;
      }
      const argsClose = partner(s, i + 1);
      if (argsClose < 0) return acc;
      const name = t.value;
      if (name === 'ForEach' || name === 'LazyForEach') {
        arrowBodies(i + 1, argsClose);
        i = skipChain(argsClose + 1);
        continue;
      }
      if (name === 'Repeat') {
        // Repeat(items).each((ri) => { ... }).template('t', (ri) => { ... }).key(...)
        let j = argsClose + 1;
        while ((isPunct(s, j, '.') || isPunct(s, j, '?.')) && isIdent(s, j + 1) && isPunct(s, j + 2, '(')) {
          const close = partner(s, j + 2);
          if (close < 0) return acc;
          const method = tok(s, j + 1).value;
          if (method === 'each' || method === 'template') arrowBodies(j + 2, close);
          j = close + 1;
        }
        i = j;
        continue;
      }
      const builder = this.pick(this.builders.get(name), file);
      const struct = builder ? undefined : this.pick(this.structs.get(name), file);
      if (builder) {
        if (!this.visiting.has(builder)) {
          this.visiting.add(builder);
          add(this.blockReach(builder.file, builder.decl.bodyOpen + 1, builder.decl.bodyClose, undefined));
          this.visiting.delete(builder);
        }
      } else if (struct) {
        const r = this.structReach(struct);
        add({ nodes: r.nodes, structs: r.structs, first: struct });
      } else if (/^[A-Z]/.test(name) && !LAYOUT_COMPONENTS.has(name)) {
        acc.nodes += 1;
      }
      let j = argsClose + 1;
      if (/^[A-Z]/.test(name) && isPunct(s, j, '{')) j = addBlock(j);
      i = skipChain(j);
    }
    return acc;
  }
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Record `const NAME = 'x'` and the string members of enums, classes, structs, namespaces and constant objects. */
function collectConstants(s: ScannedSource, out: Map<string, string>): void {
  const n = s.tokens.length;
  for (let i = 0; i + 3 < n; i++) {
    if ((isIdent(s, i, 'const') || isIdent(s, i, 'let')) && isIdent(s, i + 1)) {
      const v = stringAfterAssign(s, i + 2);
      if (v !== undefined && !out.has(tok(s, i + 1).value)) out.set(tok(s, i + 1).value, v);
    }
  }
  for (const d of s.declarations) {
    if (d.kind === 'function') continue;
    for (let i = d.bodyOpen + 1; i < d.bodyClose; i++) {
      const t = tok(s, i);
      if (t.kind === 'punct' && (t.value === '{' || t.value === '(' || t.value === '[')) {
        const p = partner(s, i);
        if (p > i) i = p;
        continue;
      }
      if (t.kind !== 'ident' || isPunct(s, i - 1, '.')) continue;
      const v = stringAfterAssign(s, i + 1, d.kind === 'object');
      if (v !== undefined) out.set(`${d.name}.${t.value}`, v);
    }
  }
}

/** The string in `= 'x'`, `: T = 'x'` or (in an object literal) `: 'x'` starting at `i`. */
function stringAfterAssign(s: ScannedSource, i: number, objectLiteral = false): string | undefined {
  const lit = (k: number): string | undefined => {
    const t = tok(s, k);
    if (t.kind !== 'string' && !(t.kind === 'template' && !t.value.includes('${'))) return undefined;
    // Only a whole literal: `'a' + x` is not a constant.
    const next = tok(s, k + 1);
    if (next.kind === 'punct' && !/^[,;})\]]$/.test(next.value)) return undefined;
    return t.text;
  };
  if (isPunct(s, i, '=')) return lit(i + 1);
  if (isPunct(s, i, ':')) {
    if (objectLiteral) return lit(i + 1);
    for (let k = i + 1; k < i + 6; k++) {
      if (isPunct(s, k, '=')) return lit(k + 1);
      if (!isIdent(s, k) && !isPunct(s, k, '.') && !isPunct(s, k, '|')) return undefined;
    }
  }
  return undefined;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function listEtsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.ets')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** `$profile:main_pages` -> `<module>/src/main/resources/base/profile/main_pages.json`. */
function profilePath(moduleDir: string, ref: unknown): string | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('$profile:')) return undefined;
  return path.join(moduleDir, 'src', 'main', 'resources', 'base', 'profile', `${ref.slice('$profile:'.length)}.json`);
}

function readJson5(file: string): unknown {
  return JSON5.parse(fs.readFileSync(file, 'utf8'));
}

/** The enclosing struct, class or function declaration of token `i` (the innermost). */
function enclosing(s: ScannedSource, i: number): Declaration | undefined {
  let best: Declaration | undefined;
  for (const d of s.declarations) {
    if (d.kind === 'object' || d.kind === 'enum') continue;
    if (d.bodyOpen < i && i < d.bodyClose && (!best || d.bodyOpen > best.bodyOpen)) best = d;
  }
  return best;
}

/** Resolve a route-target expression `[from, to)` to a string: a literal, `NAME`, `A.NAME` or `this.NAME`. */
function resolveTarget(
  idx: ProjectIndex,
  s: ScannedSource,
  from: number,
  to: number,
  owner: Declaration | undefined,
): { value: string; dynamic: boolean } | undefined {
  if (to <= from) return undefined;
  const first = tok(s, from);
  if (to - from === 1 && (first.kind === 'string' || (first.kind === 'template' && !first.value.includes('${')))) {
    return { value: first.text, dynamic: false };
  }
  const parts: string[] = [];
  let ok = true;
  for (let k = from; k < to; k++) {
    if ((k - from) % 2 === 0) {
      if (!isIdent(s, k)) ok = false;
      else parts.push(tok(s, k).value);
    } else if (!isPunct(s, k, '.')) ok = false;
  }
  if (ok && (to - from) % 2 === 1) {
    if (parts[0] === 'this' && owner) parts[0] = owner.name;
    const v = idx.constants.get(parts.join('.'));
    if (v !== undefined) return { value: v, dynamic: false };
  }
  return { value: sourceText(s, from, to - 1), dynamic: true };
}

/** The end (exclusive) of the expression starting at `i`, at the first top-level `,` or at `limit`. */
function expressionEnd(s: ScannedSource, i: number, limit: number): number {
  let e = i;
  while (e < limit && !isPunct(s, e, ',')) {
    const p = partner(s, e);
    e = p > e ? p + 1 : e + 1;
  }
  return e;
}

/** The value expression of `key: <expr>` at the top level of the object literal `{...}` at `open`. */
function objectKey(s: ScannedSource, open: number, key: string): [number, number] | undefined {
  const close = partner(s, open);
  if (close < 0) return undefined;
  for (let k = open + 1; k < close; k++) {
    const p = partner(s, k);
    if (p > k && !isPunct(s, k, '}')) {
      k = p;
      continue;
    }
    if (isIdent(s, k, key) && isPunct(s, k + 1, ':') && (k === open + 1 || isPunct(s, k - 1, ','))) {
      return [k + 2, expressionEnd(s, k + 2, close)];
    }
  }
  return undefined;
}

/** The first token of the initializer of the nearest `const|let name (: T)? = ...` before `before`, not before `from`. */
function localInitializer(s: ScannedSource, name: string, before: number, from: number): number | undefined {
  for (let k = before - 1; k > from; k--) {
    if (!isIdent(s, k, name) || !(isIdent(s, k - 1, 'const') || isIdent(s, k - 1, 'let'))) continue;
    let j = k + 1;
    if (isPunct(s, j, ':')) {
      while (j < before && !isPunct(s, j, '=') && !isPunct(s, j, ';')) j++;
    }
    return isPunct(s, j, '=') ? j + 1 : undefined;
  }
  return undefined;
}

interface RawRoute extends ScreenRoute {
  owner?: Declaration;
  fileRef: EtsFile;
}

function findRoutes(idx: ProjectIndex, f: EtsFile): RawRoute[] {
  const s = f.s;
  const out: RawRoute[] = [];
  for (let i = 1; i < s.tokens.length; i++) {
    const t = tok(s, i);
    const how = t.kind === 'ident' ? ROUTE_CALLS.get(t.value) : undefined;
    if (!how || !(isPunct(s, i - 1, '.') || isPunct(s, i - 1, '?.')) || !isPunct(s, i + 1, '(')) continue;
    const open = i + 1;
    const close = partner(s, open);
    if (close < 0) continue;
    const owner = enclosing(s, i);
    let range: [number, number] | undefined = [open + 1, expressionEnd(s, open + 1, close)];
    // The argument itself, or, for `router.pushUrl(options)`, the initializer of a local
    // `const options: RouterOptions = { url: '...' }` (or `= 'pages/X'`) in the same scope.
    let at = open + 1;
    if (range[1] === at + 1 && isIdent(s, at)) {
      const init = localInitializer(s, tok(s, at).value, i, owner?.bodyOpen ?? 0);
      if (init !== undefined) {
        const t0 = tok(s, init);
        const next = tok(s, init + 1);
        const literal =
          (t0.kind === 'string' || (t0.kind === 'template' && !t0.value.includes('${'))) &&
          (next.kind !== 'punct' || next.value === ';' || next.value === '}');
        if (literal) range = [init, init + 1];
        if (literal || isPunct(s, init, '{') || isIdent(s, init, 'new')) at = init;
      }
    }
    if (how !== 'first' && isPunct(s, at, '{')) {
      range = objectKey(s, at, how === 'url' ? 'url' : 'name');
    } else if (how === 'pathInfo' && isIdent(s, at, 'new') && isIdent(s, at + 1, 'NavPathInfo') && isPunct(s, at + 2, '(')) {
      range = [at + 3, expressionEnd(s, at + 3, partner(s, at + 2))];
    }
    if (!range) continue;
    const target = resolveTarget(idx, s, range[0], range[1], owner);
    if (!target) continue;
    out.push({
      from: owner?.name ?? f.rel,
      to: target.value,
      file: f.rel,
      line: t.line,
      via: t.value,
      ...(target.dynamic ? { dynamic: true as const } : {}),
      owner,
      fileRef: f,
    });
  }
  return out;
}

/** The route names an `if` condition compares against: its string literals and resolvable constants. */
function conditionNames(idx: ProjectIndex, s: ScannedSource, open: number, close: number, owner: Declaration | undefined): string[] {
  const names: string[] = [];
  for (let k = open + 1; k < close; k++) {
    const t = tok(s, k);
    if (t.kind === 'string') {
      names.push(t.text);
      continue;
    }
    if (t.kind === 'ident' && !isPunct(s, k - 1, '.')) {
      let e = k + 1;
      while (isPunct(s, e, '.') && isIdent(s, e + 1)) e += 2;
      if (e - k > 1 || idx.constants.has(t.value)) {
        const r = resolveTarget(idx, s, k, e, owner);
        if (r && !r.dynamic) names.push(r.value);
      }
      k = e - 1;
    }
  }
  return names;
}

function placeholdersIn(f: EtsFile): ScreenPlaceholder[] {
  const s = f.s;
  const out: ScreenPlaceholder[] = [];
  for (const c of s.comments) {
    const lines = c.text.split('\n');
    const at = lines.findIndex((l) => PLACEHOLDER_COMMENT.test(l));
    if (at < 0) continue;
    const text = (lines[at] ?? '').replace(/^\s*(\/\/+|\/\*+|\*+)\s*/, '').replace(/\s*\*+\/\s*$/, '').trim();
    out.push({ file: f.rel, line: c.line + at, text, kind: 'comment' });
  }
  for (let i = 0; i < s.tokens.length; i++) {
    const t = tok(s, i);
    if (t.kind !== 'string' && t.kind !== 'template') continue;
    if (isIdent(s, i - 1, 'from') || isIdent(s, i - 1, 'import')) continue;
    if (isPunct(s, i - 1, '(') && (isIdent(s, i - 2, '$r') || isIdent(s, i - 2, '$rawfile'))) continue;
    if (PLACEHOLDER_TEXT.test(t.text)) {
      out.push({ file: f.rel, line: t.line, text: t.text.length > 80 ? `${t.text.slice(0, 77)}...` : t.text, kind: 'text' });
    }
  }
  return out;
}

function resourcePlaceholders(projectDir: string, moduleDir: string): ScreenPlaceholder[] {
  const out: ScreenPlaceholder[] = [];
  const resDir = path.join(moduleDir, 'src', 'main', 'resources');
  let qualifiers: string[];
  try {
    qualifiers = fs.readdirSync(resDir).sort();
  } catch {
    return out;
  }
  for (const q of qualifiers) {
    const file = path.join(resDir, q, 'element', 'string.json');
    if (!fs.existsSync(file)) continue;
    let raw: string;
    let parsed: { string?: Array<{ name?: unknown; value?: unknown }> };
    try {
      raw = fs.readFileSync(file, 'utf8');
      parsed = JSON5.parse(raw);
    } catch {
      continue;
    }
    const lines = raw.split('\n');
    for (const e of parsed.string ?? []) {
      if (typeof e.value !== 'string' || typeof e.name !== 'string' || !PLACEHOLDER_TEXT.test(e.value)) continue;
      const nameRe = new RegExp(`"name"\\s*:\\s*"${e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
      const at = lines.findIndex((l) => nameRe.test(l));
      out.push({ file: toPosix(path.relative(projectDir, file)), line: at + 1, text: `${e.name}: ${e.value}`, kind: 'resource' });
    }
  }
  return out;
}

/**
 * Build the static screen inventory of an OpenHarmony/HarmonyOS project: its pages (`@Entry` pages from
 * `main_pages.json`, `NavDestination`s from route maps and `.navDestination()` builders), the route call sites
 * between them, and placeholder markers. Reads every module in `build-profile.json5`; needs no SDK and no build.
 * Throws `OniroError` when the project cannot be read.
 */
export function inventoryScreens(opts: ScreensOptions): ScreensInventory {
  const projectDir = path.resolve(opts.projectDir);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new OniroError(`Project directory not found: ${projectDir}`);
  }
  const modules = listModules({ projectDir });
  const warnings: string[] = [];
  const files: EtsFile[] = [];
  const moduleInfo: Array<{ name: string; dir: string; json: Record<string, unknown> | undefined }> = [];
  const rel = (p: string): string => toPosix(path.relative(projectDir, p));

  for (const m of modules) {
    const dir = path.resolve(projectDir, m.srcPath);
    const etsDir = path.join(dir, 'src', 'main', 'ets');
    const moduleJson = path.join(dir, 'src', 'main', 'module.json5');
    let json: Record<string, unknown> | undefined;
    if (fs.existsSync(moduleJson)) {
      try {
        json = (readJson5(moduleJson) as { module?: Record<string, unknown> }).module;
      } catch (err) {
        warnings.push(`${rel(moduleJson)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      warnings.push(`module ${m.name}: ${rel(moduleJson)} not found`);
    }
    moduleInfo.push({ name: m.name, dir, json });
    for (const abs of listEtsFiles(etsDir)) {
      let src: string;
      try {
        src = fs.readFileSync(abs, 'utf8');
      } catch {
        warnings.push(`${rel(abs)}: cannot be read`);
        continue;
      }
      files.push({
        abs,
        rel: rel(abs),
        module: m.name,
        etsPath: toPosix(path.relative(etsDir, abs)).replace(/\.ets$/, ''),
        s: scanEts(src),
      });
    }
  }

  const idx = new ProjectIndex(files);
  const pages: Array<ScreenPage & { reach: Reach; st?: StructInfo; builder?: Declaration; builderFile?: EtsFile }> = [];
  const pageNames = new Set<string>();
  const addPage = (p: (typeof pages)[number]): void => {
    const key = `${p.module}\u0000${p.name}`;
    if (pageNames.has(key)) {
      warnings.push(`page ${p.name} (module ${p.module}) is registered more than once; ${p.file}:${p.line} is ignored`);
      return;
    }
    pageNames.add(key);
    pages.push(p);
  };
  const isEntry = (st: StructInfo): boolean => st.decl.decorators.some((d) => d.name === 'Entry');
  const structsIn = (f: EtsFile): StructInfo[] =>
    [...idx.structs.values()].flat().filter((st) => st.file === f).sort((a, b) => a.decl.nameIndex - b.decl.nameIndex);
  const entryRouteName = (st: StructInfo): string | undefined => {
    const dec = st.decl.decorators.find((d) => d.name === 'Entry');
    if (dec?.argsOpen === undefined) return undefined;
    const s = st.file.s;
    if (!isPunct(s, dec.argsOpen + 1, '{')) return undefined;
    const r = objectKey(s, dec.argsOpen + 1, 'routeName');
    return r ? resolveTarget(idx, s, r[0], r[1], undefined)?.value : undefined;
  };

  const entryPage = (st: StructInfo, name: string, registered: boolean): (typeof pages)[number] => {
    const reach = idx.structReach(st);
    return {
      name,
      module: st.file.module,
      file: st.file.rel,
      line: st.decl.line,
      component: st.name,
      entry: isEntry(st),
      kind: 'entry',
      registered,
      contentNodes: reach.nodes,
      routesOut: [],
      reach,
      st,
    };
  };

  // 1. @Entry pages listed in main_pages.json.
  const listedStructs = new Set<StructInfo>();
  for (const m of moduleInfo) {
    const profile = profilePath(m.dir, m.json?.pages);
    if (!profile) continue;
    let src: unknown[] = [];
    try {
      const parsed = readJson5(profile) as { src?: unknown };
      src = Array.isArray(parsed.src) ? parsed.src : [];
    } catch (err) {
      warnings.push(`${rel(profile)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const entry of src) {
      if (typeof entry !== 'string') continue;
      const file = files.find((f) => f.module === m.name && f.etsPath === entry);
      if (!file) {
        warnings.push(`${rel(profile)} lists ${entry}, but ${rel(path.join(m.dir, 'src', 'main', 'ets', `${entry}.ets`))} does not exist`);
        continue;
      }
      const structs = structsIn(file);
      const st = structs.find(isEntry);
      if (!st) {
        warnings.push(`${file.rel} is listed in ${rel(profile)} but declares no @Entry struct`);
        continue;
      }
      listedStructs.add(st);
      addPage(entryPage(st, entry, true));
    }
  }
  // 2. Other @Entry structs: named routes (`@Entry({ routeName })`) and pages main_pages.json does not list.
  for (const f of files) {
    for (const st of structsIn(f).filter(isEntry)) {
      if (listedStructs.has(st)) continue;
      const routeName = entryRouteName(st);
      if (!routeName) warnings.push(`${f.rel}: @Entry ${st.name} is not listed in main_pages.json`);
      addPage(entryPage(st, routeName ?? f.etsPath, routeName !== undefined));
    }
  }

  // 3. NavDestinations registered in a route map (module.json5 `routerMap`).
  for (const m of moduleInfo) {
    const profile = profilePath(m.dir, m.json?.routerMap);
    if (!profile) continue;
    let entries: unknown[] = [];
    try {
      const parsed = readJson5(profile) as { routerMap?: unknown };
      entries = Array.isArray(parsed.routerMap) ? parsed.routerMap : [];
    } catch (err) {
      warnings.push(`${rel(profile)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const e of entries as Array<{ name?: unknown; pageSourceFile?: unknown; buildFunction?: unknown }>) {
      if (typeof e.name !== 'string' || typeof e.pageSourceFile !== 'string') continue;
      const abs = path.resolve(m.dir, e.pageSourceFile);
      const file = files.find((f) => f.abs === abs);
      if (!file) {
        warnings.push(`${rel(profile)}: route ${e.name} names ${e.pageSourceFile}, which does not exist under ${rel(m.dir)}`);
        continue;
      }
      const fn = typeof e.buildFunction === 'string'
        ? idx.builders.get(e.buildFunction)?.find((b) => b.file === file)
        : undefined;
      if (!fn) {
        warnings.push(`${rel(profile)}: route ${e.name}: no @Builder function ${String(e.buildFunction)} in ${file.rel}`);
        continue;
      }
      const reach = idx.blockReach(file, fn.decl.bodyOpen + 1, fn.decl.bodyClose, undefined);
      addPage({
        name: e.name,
        module: m.name,
        file: file.rel,
        line: reach.first?.decl.line ?? fn.decl.line,
        component: reach.first?.name ?? null,
        entry: false,
        kind: 'navDestination',
        registered: true,
        contentNodes: reach.nodes,
        routesOut: [],
        reach,
        st: reach.first,
        builder: fn.decl,
        builderFile: file,
      });
    }
  }

  // 4. NavDestinations dispatched by name in a `.navDestination(builder)` builder.
  for (const f of files) {
    const s = f.s;
    for (let i = 1; i < s.tokens.length; i++) {
      if (!isIdent(s, i, 'navDestination') || !isPunct(s, i - 1, '.') || !isPunct(s, i + 1, '(')) continue;
      const close = partner(s, i + 1);
      if (close < 0) continue;
      const owner = enclosing(s, i);
      const ownerStruct = owner?.kind === 'struct' ? idx.pick(idx.structs.get(owner.name), f) : undefined;
      // `this.routes`, `this.routes.bind(this)`, `PageMap` (a global @Builder).
      let builderFile = f;
      let body: { open: number; close: number; line: number; name: string } | undefined;
      let builderOwner: StructInfo | undefined;
      if (isIdent(s, i + 2, 'this') && isPunct(s, i + 3, '.') && isIdent(s, i + 4)) {
        const m = ownerStruct?.methods.get(tok(s, i + 4).value);
        if (m) {
          body = { open: m.bodyOpen, close: m.bodyClose, line: m.line, name: m.name };
          builderOwner = ownerStruct;
        }
      } else if (isIdent(s, i + 2)) {
        const b = idx.pick(idx.builders.get(tok(s, i + 2).value), f);
        if (b) {
          body = { open: b.decl.bodyOpen, close: b.decl.bodyClose, line: b.decl.line, name: b.name };
          builderFile = b.file;
        }
      }
      if (!body) {
        warnings.push(`${f.rel}:${tok(s, i).line}: .navDestination(${sourceText(s, i + 2, close - 1)}) builder not found`);
        continue;
      }
      const bs = builderFile.s;
      const ownerDecl = builderOwner?.decl;
      let unnamed = false;
      let named = 0;
      for (let k = body.open + 1; k < body.close; k++) {
        if (!isIdent(bs, k, 'if') || !isPunct(bs, k + 1, '(')) continue;
        // Walk the whole if / else if / else chain at this level.
        let j = k;
        for (;;) {
          let names: string[] = [];
          let blockOpen: number;
          if (isIdent(bs, j, 'if')) {
            const condClose = partner(bs, j + 1);
            if (condClose < 0) break;
            names = conditionNames(idx, bs, j + 1, condClose, ownerDecl);
            blockOpen = condClose + 1;
          } else {
            blockOpen = j; // a plain `else`: the fallback for unknown names, not a route
          }
          if (!isPunct(bs, blockOpen, '{')) break;
          const blockClose = partner(bs, blockOpen);
          if (blockClose < 0) break;
          if (names.length) {
            for (const name of names) {
              named++;
              const reach = idx.blockReach(builderFile, blockOpen + 1, blockClose, builderOwner);
              addPage({
                name,
                module: f.module,
                file: reach.first?.file.rel ?? builderFile.rel,
                line: reach.first?.decl.line ?? tok(bs, j).line,
                component: reach.first?.name ?? null,
                entry: false,
                kind: 'navDestination',
                registered: true,
                contentNodes: reach.nodes,
                routesOut: [],
                reach,
                st: reach.first,
              });
            }
          } else if (isIdent(bs, j, 'if')) {
            unnamed = true;
          }
          j = blockClose + 1;
          if (!isIdent(bs, j, 'else')) break;
          j++;
        }
        k = j - 1;
      }
      if (unnamed) {
        warnings.push(`${builderFile.rel}:${body.line}: navDestination builder ${body.name} has a branch whose route name is not a string literal or constant`);
      } else if (!named) {
        warnings.push(`${builderFile.rel}:${body.line}: navDestination builder ${body.name} dispatches on no route name (no if (name === '...') branch)`);
      }
    }
  }

  // 5. Structs rooted in NavDestination that nothing registers.
  const covered = new Set(pages.map((p) => p.component).filter((c): c is string => Boolean(c)));
  for (const list of idx.structs.values()) {
    for (const st of list) {
      if (covered.has(st.name) || isEntry(st)) continue;
      const build = st.methods.get('build');
      if (!build || !isIdent(st.file.s, build.bodyOpen + 1, 'NavDestination')) continue;
      const reach = idx.structReach(st);
      addPage({
        name: st.name,
        module: st.file.module,
        file: st.file.rel,
        line: st.decl.line,
        component: st.name,
        entry: false,
        kind: 'navDestination',
        registered: false,
        contentNodes: reach.nodes,
        routesOut: [],
        reach,
        st,
      });
    }
  }

  // Route call sites, attributed to the page whose component holds them.
  const rawRoutes = files.flatMap((f) => findRoutes(idx, f));
  const pageOfStruct = new Map<string, string>();
  for (const p of pages) {
    if (p.component && !pageOfStruct.has(`${p.module}\u0000${p.component}`)) pageOfStruct.set(`${p.module}\u0000${p.component}`, p.name);
  }
  const routes: ScreenRoute[] = rawRoutes.map((r) => {
    const from = r.owner?.kind === 'struct' ? pageOfStruct.get(`${r.fileRef.module}\u0000${r.owner.name}`) : undefined;
    const { owner: _o, fileRef: _f, ...route } = r;
    return { ...route, from: from ?? route.from };
  });
  for (const p of pages) {
    const out = new Set<string>();
    for (const r of rawRoutes) {
      if (r.via === 'loadContent' || r.dynamic) continue;
      const inStruct = r.owner?.kind === 'struct' && [...p.reach.structs].some((st) => st.decl === r.owner && st.file === r.fileRef);
      const inBuilder = p.builder !== undefined && r.owner === p.builder && r.fileRef === p.builderFile;
      if (inStruct || inBuilder) out.add(r.to);
    }
    p.routesOut = [...out];
  }

  // Placeholders: markers in sources and resources, empty builds, pages with no content.
  const placeholders: ScreenPlaceholder[] = files.flatMap(placeholdersIn);
  for (const m of moduleInfo) placeholders.push(...resourcePlaceholders(projectDir, m.dir));
  const emptyBuilds = new Set<StructInfo>();
  for (const list of idx.structs.values()) {
    for (const st of list) {
      const build = st.methods.get('build');
      if (build && build.bodyClose === build.bodyOpen + 1) {
        emptyBuilds.add(st);
        placeholders.push({ file: st.file.rel, line: build.line, text: `empty build() in ${st.name}`, kind: 'empty-build' });
      }
    }
  }
  for (const p of pages) {
    if (p.contentNodes === 0 && !(p.st && emptyBuilds.has(p.st))) {
      placeholders.push({ file: p.file, line: p.line, text: `page ${p.name} renders no content nodes`, kind: 'no-content' });
    }
  }
  placeholders.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    projectDir,
    modules: modules.map((m) => m.name),
    pages: pages.map(({ reach: _r, st: _s, builder: _b, builderFile: _bf, ...p }) => p),
    routes,
    placeholders,
    warnings,
  };
}
