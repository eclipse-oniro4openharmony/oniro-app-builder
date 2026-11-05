import type * as TS from 'typescript';
import type { ApiEntry, ApiSymbolKind } from './types.js';
import { fileHeaderTags, mergeDocBlocks, type DocTags } from './jsdoc.js';

/**
 * Extract declarations from one ArkTS declaration file (`.d.ts` or `.d.ets`) with the
 * TypeScript parser (only `createSourceFile`, no program or type checker). `struct`
 * (a custom component in `.d.ets`) is not TypeScript, so it is rewritten to `class `
 * (same length, so positions and lines are kept) before parsing, and the classes it
 * produced are reported as components.
 */

type Ts = typeof TS;

/** Names an interface's call signatures: what `declare const Column: ColumnInterface` resolves through. */
export interface CallSignatureInfo {
  signature: string;
  line: number;
  tags: DocTags;
}

export interface FileDeclarations {
  entries: ApiEntry[];
  /** `export default <name>` of the file. */
  defaultExport?: string;
  /** Interfaces with call signatures, by name. */
  callableInterfaces: Map<string, CallSignatureInfo[]>;
  /** `declare const X: YInterface` candidates waiting for the interface, by entry index. */
  componentCandidates: Array<{ entry: ApiEntry; typeName: string }>;
}

export interface FileContext {
  /** Relative to the SDK directory. */
  relPath: string;
  module: string;
  global: boolean;
}

const MAX_SIGNATURE = 400;

/** Collapse whitespace and drop comments in a declaration's text, truncating a very long one. */
export function cleanSignature(text: string): string {
  let s = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*;$/, '');
  if (s.length > MAX_SIGNATURE) s = `${s.slice(0, MAX_SIGNATURE - 1)}…`;
  return s;
}

// `declare struct X` / `export declare struct X` / `export struct X`: never the word in a comment.
const STRUCT_RE = /(^|[\s;}])((?:export\s+)?declare\s+|export\s+)struct(\s+[A-Za-z_$])/g;

/** `struct X` -> `class  X` (same length) and the names it renamed. */
export function rewriteStructs(text: string): { text: string; structs: Set<string> } {
  const structs = new Set<string>();
  const out = text.replace(STRUCT_RE, (_m, pre: string, mods: string, rest: string) => `${pre}${mods}class ${rest}`);
  const nameRe = /(?:^|[\s;}])(?:(?:export\s+)?declare\s+|export\s+)struct\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(text))) structs.add(m[1]!);
  return { text: out, structs };
}

export function extractTsDeclarations(ts: Ts, text: string, ctx: FileContext): FileDeclarations {
  const { text: source, structs } = rewriteStructs(text);
  const sf = ts.createSourceFile(ctx.relPath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const header = fileHeaderTags(source);
  const kit = header.kit ? `@kit.${header.kit}` : undefined;
  const result: FileDeclarations = { entries: [], callableInterfaces: new Map(), componentCandidates: [] };
  const seen = new Set<string>();

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const docOf = (node: TS.Node): DocTags => {
    const ranges = ts.getLeadingCommentRanges(source, node.pos) ?? [];
    const blocks = ranges
      .filter((r) => source.startsWith('/**', r.pos))
      .map((r) => source.slice(r.pos, r.end));
    return mergeDocBlocks(blocks);
  };

  const nameText = (name: TS.Node | undefined): string | undefined => {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) return `[${name.expression.getText(sf)}]`;
    return undefined;
  };

  const add = (
    kind: ApiSymbolKind,
    name: string,
    qualifiedName: string,
    node: TS.Node,
    signature: string,
    own: DocTags,
    parent: DocTags | undefined,
  ): { entry: ApiEntry; tags: DocTags } => {
    // Members inherit what their parent declares and they do not.
    const tags: DocTags = { ...own };
    if (parent) {
      if (tags.since === undefined && parent.since !== undefined) tags.since = parent.since;
      if (tags.deprecated === undefined && parent.deprecated !== undefined) {
        tags.deprecated = parent.deprecated;
        if (parent.deprecatedSince !== undefined) tags.deprecatedSince = parent.deprecatedSince;
      }
      if (!tags.syscap && parent.syscap) tags.syscap = parent.syscap;
      if (!tags.systemApi && parent.systemApi) tags.systemApi = true;
    }
    const entry: ApiEntry = {
      name,
      qualifiedName,
      kind,
      language: 'arkts',
      module: ctx.module,
      file: ctx.relPath,
      line: lineOf(node.getStart(sf)),
      signature,
    };
    if (kit) entry.kit = kit;
    if (ctx.global) entry.global = true;
    if (tags.since !== undefined) entry.since = tags.since;
    if (tags.sinceText) entry.sinceText = tags.sinceText;
    if (tags.deprecated !== undefined) entry.deprecated = tags.deprecated;
    if (tags.deprecatedSince !== undefined) entry.deprecatedSince = tags.deprecatedSince;
    if (tags.useInstead) entry.useInstead = tags.useInstead;
    if (tags.syscap) entry.syscap = tags.syscap;
    if (tags.systemApi) entry.systemApi = true;
    if (tags.doc) entry.doc = tags.doc;
    // Doc blocks repeated per API level sometimes come with repeated declarations.
    const dedupe = `${qualifiedName}\u0000${kind}\u0000${signature}`;
    if (!seen.has(dedupe)) {
      seen.add(dedupe);
      result.entries.push(entry);
    }
    return { entry, tags };
  };

  const header_ = (node: TS.Node, end: number): string => cleanSignature(source.slice(node.getStart(sf), end));
  const full = (node: TS.Node): string => cleanSignature(source.slice(node.getStart(sf), node.end));
  const qualify = (prefix: string, name: string): string => (prefix ? `${prefix}.${name}` : name);

  const visitMembers = (
    members: TS.NodeArray<TS.ClassElement | TS.TypeElement>,
    prefix: string,
    parentTags: DocTags,
    interfaceName: string | undefined,
  ): void => {
    for (const m of members) {
      const own = docOf(m);
      if (ts.isCallSignatureDeclaration(m)) {
        if (interfaceName) {
          const list = result.callableInterfaces.get(interfaceName) ?? [];
          const tags = { ...own };
          if (tags.since === undefined && parentTags.since !== undefined) tags.since = parentTags.since;
          if (!tags.syscap && parentTags.syscap) tags.syscap = parentTags.syscap;
          list.push({ signature: full(m), line: lineOf(m.getStart(sf)), tags });
          result.callableInterfaces.set(interfaceName, list);
        }
        continue;
      }
      if (ts.isConstructorDeclaration(m) || ts.isConstructSignatureDeclaration(m)) {
        add('constructor', 'constructor', qualify(prefix, 'constructor'), m, full(m), own, parentTags);
        continue;
      }
      if (ts.isIndexSignatureDeclaration(m) || ts.isClassStaticBlockDeclaration(m)) continue;
      const name = nameText(m.name);
      if (!name) continue;
      const kind: ApiSymbolKind =
        ts.isMethodDeclaration(m) || ts.isMethodSignature(m) ? 'method' : 'property';
      add(kind, name, qualify(prefix, name), m, full(m), own, parentTags);
    }
  };

  const decoratorType = /\b\w*Decorator\b/;

  const visitStatements = (statements: readonly TS.Statement[], prefix: string, parentTags: DocTags | undefined): void => {
    for (const st of statements) {
      if (ts.isModuleDeclaration(st)) {
        const name = nameText(st.name);
        if (!name) continue;
        const own = docOf(st);
        let tags = parentTags;
        let next = prefix;
        // `declare global { ... }` augments the global scope: no namespace of its own.
        if (name !== 'global') {
          const bodyStart = st.body ? st.body.getStart(sf) : st.end;
          tags = add('namespace', name, qualify(prefix, name), st, header_(st, bodyStart), own, parentTags).tags;
          next = qualify(prefix, name);
        }
        let body: TS.ModuleBody | undefined = st.body;
        // `namespace a.b { }` nests ModuleDeclarations.
        while (body && ts.isModuleDeclaration(body)) {
          const inner = nameText(body.name);
          if (inner) next = qualify(next, inner);
          body = body.body;
        }
        if (body && ts.isModuleBlock(body)) visitStatements(body.statements, next, tags);
      } else if (ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) {
        const name = nameText(st.name);
        if (!name) continue;
        const isStruct = ts.isClassDeclaration(st) && structs.has(name);
        const kind: ApiSymbolKind = isStruct ? 'component' : ts.isClassDeclaration(st) ? 'class' : 'interface';
        let headerText = header_(st, st.members.pos - 1);
        if (isStruct) headerText = headerText.replace(/\bclass(\s+)/, 'struct$1');
        const { tags } = add(kind, name, qualify(prefix, name), st, headerText, docOf(st), parentTags);
        visitMembers(st.members, qualify(prefix, name), tags, ts.isInterfaceDeclaration(st) ? name : undefined);
        if (
          ts.isClassDeclaration(st) &&
          st.modifiers?.some((mo) => mo.kind === ts.SyntaxKind.DefaultKeyword) &&
          !prefix
        ) {
          result.defaultExport = name;
        }
      } else if (ts.isEnumDeclaration(st)) {
        const name = st.name.text;
        const { tags } = add('enum', name, qualify(prefix, name), st, header_(st, st.members.pos - 1), docOf(st), parentTags);
        for (const m of st.members) {
          const mn = nameText(m.name);
          if (mn) add('enumMember', mn, qualify(qualify(prefix, name), mn), m, full(m), docOf(m), tags);
        }
      } else if (ts.isFunctionDeclaration(st)) {
        const name = nameText(st.name);
        if (!name) continue;
        add('function', name, qualify(prefix, name), st, full(st), docOf(st), parentTags);
        if (st.modifiers?.some((mo) => mo.kind === ts.SyntaxKind.DefaultKeyword) && !prefix) {
          result.defaultExport = name;
        }
      } else if (ts.isTypeAliasDeclaration(st)) {
        add('type', st.name.text, qualify(prefix, st.name.text), st, full(st), docOf(st), parentTags);
      } else if (ts.isVariableStatement(st)) {
        const own = docOf(st);
        for (const d of st.declarationList.declarations) {
          const name = nameText(d.name);
          if (!name) continue;
          const typeText = d.type ? d.type.getText(sf) : '';
          const sig =
            st.declarationList.declarations.length === 1 ? full(st) : cleanSignature(`declare const ${d.getText(sf)}`);
          let kind: ApiSymbolKind = 'variable';
          if (decoratorType.test(typeText)) kind = 'decorator';
          // `declare const ColumnInstance: ColumnAttribute` only backs the component's attribute chain.
          else if (/Instance$/.test(name) && /Attribute$/.test(typeText) && ctx.global) continue;
          const { entry } = add(kind, name, qualify(prefix, name), st, sig, own, parentTags);
          if (kind === 'variable' && d.type && ts.isTypeReferenceNode(d.type) && ts.isIdentifier(d.type.typeName)) {
            result.componentCandidates.push({ entry, typeName: d.type.typeName.text });
          }
        }
      } else if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) {
        result.defaultExport = st.expression.text;
      }
    }
  };

  visitStatements(sf.statements, '', undefined);
  return result;
}

/**
 * Turn `declare const Column: ColumnInterface` into component entries, one per call
 * signature of the interface (`Column(options?: ColumnOptions): ColumnAttribute`).
 * Mutates `entries`: the variable entry is replaced. Candidates whose type has no call
 * signature stay variables.
 */
export function resolveComponents(
  entries: ApiEntry[],
  candidates: ReadonlyArray<{ entry: ApiEntry; typeName: string }>,
  callable: ReadonlyMap<string, CallSignatureInfo[]>,
): ApiEntry[] {
  const replace = new Map<ApiEntry, ApiEntry[]>();
  for (const { entry, typeName } of candidates) {
    const sigs = callable.get(typeName);
    if (!sigs?.length || !entry.global) continue;
    const seen = new Set<string>();
    const out: ApiEntry[] = [];
    for (const s of sigs) {
      const signature = `${entry.name}${s.signature}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      const e: ApiEntry = { ...entry, kind: 'component', signature };
      if (s.tags.doc && !e.doc) e.doc = s.tags.doc;
      if (s.tags.since !== undefined && (e.since === undefined || s.tags.since < e.since)) e.since = s.tags.since;
      out.push(e);
    }
    replace.set(entry, out);
  }
  if (!replace.size) return entries;
  return entries.flatMap((e) => replace.get(e) ?? [e]);
}
