/**
 * Types of the SDK declaration index behind `oniro-app api search` and `api show`:
 * every class, interface, function, member, enum, ArkUI component and decorator the
 * ArkTS declaration files of one SDK API level declare, and the Node-API C functions,
 * types and macros its native sysroot headers declare.
 */

export type ApiSymbolKind =
  | 'namespace'
  | 'class'
  | 'interface'
  | 'enum'
  | 'enumMember'
  | 'type'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'variable'
  /** An ArkUI built-in component (`declare const Column: ColumnInterface`) or a declared `struct`. */
  | 'component'
  /** An ArkUI decorator (`declare const Local: PropertyDecorator`). */
  | 'decorator'
  /** C: a `#define`. */
  | 'macro'
  /** C: a `typedef`. */
  | 'typedef'
  /** C: a `typedef struct { ... }`. */
  | 'struct';

export type ApiLanguage = 'arkts' | 'c';

export interface ApiEntry {
  /** The declared name: `pushPathByName`. */
  name: string;
  /** The name with its enclosing namespaces, classes and interfaces: `NavPathStack.pushPathByName`. */
  qualifiedName: string;
  kind: ApiSymbolKind;
  language: ApiLanguage;
  /**
   * The module that declares it: `@ohos.router`, `@arkts.collections`, a path under
   * `ets/api` for files that are not modules (`application/UIAbilityContext`), `component/navigation`
   * for the global ArkUI declarations, or the header (`napi/native_api.h`).
   */
  module: string;
  /** The kit that exports it (`@kit.ArkUI`): from the `ets/kits` re-exports, else the file's `@kit` tag. */
  kit?: string;
  /** How an app imports it, when a kit or module exports it: `import { router } from '@kit.ArkUI'`. */
  import?: string;
  /** Declared globally (the ArkUI component files): usable without an import. */
  global?: boolean;
  /** The API level that introduced it: the lowest `@since` of its doc comments (or its parent's). */
  since?: number;
  /** The `@since` values as written, when one carries more than a number (`12 dynamic`, `23 static`). */
  sinceText?: string;
  /** `@deprecated` as written (`since 9`); an empty string when the tag has no text. */
  deprecated?: string;
  /** The API level of `@deprecated since N`. */
  deprecatedSince?: number;
  /** `@useinstead`: what to use instead. */
  useInstead?: string;
  /** `@syscap`. */
  syscap?: string;
  /** `@systemapi`: only system apps may call it. */
  systemApi?: boolean;
  /** The file that declares it, relative to the SDK directory (`ets/component/navigation.d.ts`). */
  file: string;
  /** 1-based line of the declaration (not of its doc comment). */
  line: number;
  /** The declaration text, whitespace collapsed (the header only for classes, interfaces, namespaces and enums). */
  signature: string;
  /** The first line of its doc comment. */
  doc?: string;
}

/** The index of one SDK directory. */
export interface ApiIndex {
  /** Bumped whenever the shape or the extraction changes, so old caches are rebuilt. */
  format: number;
  /** The SDK API directory indexed (holding `ets/` and `native/`). */
  sdkDir: string;
  /** The API level from `ets/oh-uni-package.json`. */
  api?: number;
  /** The SDK version from `ets/oh-uni-package.json` (`6.0.0.47`). */
  sdkVersion?: string;
  /** What the cache is keyed by: the SDK directory and the mtimes of its `oh-uni-package.json` files. */
  key: string;
  builtAt: string;
  /** Declaration files read. */
  files: number;
  buildMs: number;
  entries: ApiEntry[];
}
