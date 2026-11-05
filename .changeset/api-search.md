---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- New `api search <query...>`: a ranked search of what the SDK at one API level declares, read from its own typings:
  the ArkTS API (`ets/api`, `ets/arkts`), the global ArkUI components and decorators (`ets/component`), with the kit
  that re-exports each symbol (`ets/kits/@kit.*.d.ts`), and the Node-API headers (`node_api*.h`,
  `js_native_api*.h`, `napi/*.h`). Each hit has the symbol, its kind (class, interface, function, method, property,
  enum, namespace, component, decorator, macro, ...), kit, module, how to import it, `@since`, `@deprecated` with
  `@useinstead`, `@syscap`, `@systemapi`, `file:line`, the declaration text and the first doc line. `--kit`,
  `--kind`, `--lang`, `--limit`, `--no-deprecated`, `--no-systemapi`, `--json`.
- New `api show <symbol>`: an exact lookup (`NavPathStack.pushPathByName`, `router.pushUrl`, `@Local`) that exits 1
  when the SDK does not declare the symbol, naming the other installed SDKs that do (with their `@since`) and the
  closest names this SDK declares. `api index` builds or refreshes an index.
- The SDK is `--sdk`, `--api`, the project's `compileSdkVersion`, or the newest installed one. The index is built on
  first use with the SDK's bundled TypeScript (about 3 s for API 23) and cached under `~/.oniro/cache`
  (`ONIRO_CACHE_DIR`, config key `cacheDir`), rebuilt when the SDK is reinstalled.
- Core exports `loadApiIndex`, `buildApiIndex`, `searchApi`, `showApi`, `suggestApiSymbols`, `findApiInOtherSdks`,
  `resolveApiSdk` and the `ApiEntry` and `ApiIndex` types.
