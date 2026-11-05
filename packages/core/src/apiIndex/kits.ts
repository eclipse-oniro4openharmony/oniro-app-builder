import type * as TS from 'typescript';

/**
 * What the `ets/kits/@kit.X.d.ts` files re-export. A kit file imports names from the
 * `@ohos.*` modules (a default import for a module's namespace, named imports for
 * its classes and types) and re-exports them, so `import { router } from '@kit.ArkUI'`
 * reaches `@ohos.router`'s default export.
 */

type Ts = typeof TS;

export interface KitExport {
  /** `@kit.ArkUI`. */
  kit: string;
  /** The name the kit exports it under. */
  name: string;
}

export interface KitMap {
  /** `${module}#${name}` (or `${module}#default`) -> where it is exported. */
  bySymbol: Map<string, KitExport>;
  /** module -> the first kit importing anything from it. */
  byModule: Map<string, string>;
}

export function emptyKitMap(): KitMap {
  return { bySymbol: new Map(), byModule: new Map() };
}

/** Add one kit file's re-exports to `map`. `kit` is the file's module name (`@kit.ArkUI`). */
export function addKitFile(ts: Ts, map: KitMap, kit: string, text: string): void {
  const sf = ts.createSourceFile(`${kit}.d.ts`, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // local binding -> [module, imported name ('default' for a default import)]
  const locals = new Map<string, [string, string]>();
  const exported = new Map<string, string>(); // local -> exported name
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const module = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (!clause) continue;
      if (!map.byModule.has(module)) map.byModule.set(module, kit);
      if (clause.name) locals.set(clause.name.text, [module, 'default']);
      const nb = clause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          locals.set(el.name.text, [module, (el.propertyName ?? el.name).text]);
        }
      } else if (nb && ts.isNamespaceImport(nb)) {
        locals.set(nb.name.text, [module, '*']);
      }
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        exported.set((el.propertyName ?? el.name).text, el.name.text);
      }
    }
  }
  for (const [local, [module, imported]] of locals) {
    const name = exported.get(local);
    if (!name) continue;
    const key = `${module}#${imported}`;
    if (!map.bySymbol.has(key)) map.bySymbol.set(key, { kit, name });
  }
}
