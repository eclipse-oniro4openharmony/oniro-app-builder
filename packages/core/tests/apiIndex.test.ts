import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  buildApiIndex,
  deserializeApiIndex,
  loadApiIndex,
  serializeApiIndex,
  apiIndexCachePath,
} from '../src/apiIndex/buildIndex.js';
import { mergeDocBlocks, parseDocBlock } from '../src/apiIndex/jsdoc.js';
import { nameParts, normalizeKit, searchApi, showApi } from '../src/apiIndex/search.js';
import { findApiInOtherSdks, suggestApiSymbols } from '../src/apiIndex/lookup.js';
import { resolveApiSdk, installedApiLevels } from '../src/apiIndex/resolveSdk.js';
import { extractNativeDeclarations } from '../src/apiIndex/nativeHeaders.js';
import { rewriteStructs } from '../src/apiIndex/tsDeclarations.js';
import type { ApiEntry, ApiIndex } from '../src/apiIndex/types.js';
import { staticConfig } from '../src/ports/config.js';
import { getOsFolder } from '../src/sdk/platform.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'api-sdk');
const SDK18 = path.join(FIXTURES, '18');
const SDK23 = path.join(FIXTURES, '23');

const one = (index: ApiIndex, qualifiedName: string, kind?: string): ApiEntry => {
  const found = index.entries.filter((e) => e.qualifiedName === qualifiedName && (!kind || e.kind === kind));
  expect(found, `${qualifiedName} ${kind ?? ''}`).not.toHaveLength(0);
  return found[0]!;
};

describe('doc comment tags', () => {
  it('reads since, deprecation, useinstead, syscap, systemapi and the first doc line', () => {
    const t = parseDocBlock(`/**
     * Navigates to a <b>page</b> by {@link RouterOptions}.
     *
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @systemapi
     * @since 9
     * @deprecated since 18
     * @useinstead ohos.arkui.UIContext.Router#pushUrl
     */`);
    expect(t).toEqual({
      doc: 'Navigates to a page by RouterOptions.',
      syscap: 'SystemCapability.ArkUI.ArkUI.Full',
      systemApi: true,
      since: 9,
      deprecated: 'since 18',
      deprecatedSince: 18,
      useInstead: 'ohos.arkui.UIContext.Router#pushUrl',
    });
  });

  it('keeps a qualified @since (`12 dynamic`) as text next to the number', () => {
    const t = mergeDocBlocks(['/**\n * @since 12 dynamic\n * @since 23 static\n */']);
    expect(t.since).toBe(12);
    expect(t.sinceText).toBe('12 dynamic, 23 static');
    const two = mergeDocBlocks(['/** @since 12 dynamic */', '/** @since 23 static */']);
    expect(two.sinceText).toBe('12 dynamic, 23 static');
  });

  it('takes the lowest @since over stacked blocks, and the newest block for syscap and doc', () => {
    const t = mergeDocBlocks([
      '/**\n * Old doc.\n * @syscap A\n * @since 10\n */',
      '/**\n * New doc.\n * @syscap B\n * @atomicservice\n * @since 11\n */',
    ]);
    expect(t).toMatchObject({ since: 10, syscap: 'B', doc: 'New doc.' });
  });

  it('dates a system API made public from its first public block', () => {
    const t = mergeDocBlocks(['/**\n * @systemapi\n * @since 12\n */', '/**\n * @atomicservice\n * @since 23\n */']);
    expect(t.since).toBe(23);
    expect(t.systemApi).toBeUndefined();
  });

  it('skips file-header blocks', () => {
    expect(mergeDocBlocks(['/**\n * @file\n * @kit ArkUI\n */'])).toEqual({});
  });
});

describe('buildApiIndex (fixture SDK, API 18)', () => {
  let index: ApiIndex;
  beforeAll(() => {
    index = buildApiIndex(SDK18, { typescript: ts });
  });

  it('records the SDK, the files read and the build time', () => {
    expect(index.api).toBe(18);
    expect(index.sdkVersion).toBe('5.1.0.107');
    expect(index.sdkDir).toBe(path.resolve(SDK18));
    // 6 ArkTS declaration files and 3 headers; the 2 kit files only map exports.
    expect(index.files).toBe(9);
    expect(index.entries.some((e) => e.file.startsWith('ets/kits/'))).toBe(false);
  });

  it('indexes a global ArkUI class and its members with file:line, kit and since', () => {
    const cls = one(index, 'NavPathStack', 'class');
    expect(cls).toMatchObject({
      kind: 'class',
      kit: '@kit.ArkUI',
      module: 'component/navigation',
      global: true,
      since: 10,
      file: 'ets/component/navigation.d.ts',
      line: 23,
      signature: 'declare class NavPathStack',
      syscap: 'SystemCapability.ArkUI.ArkUI.Full',
      doc: 'Indicates the information of NavDestinations. Providers methods for controlling destination page in the stack',
    });
    expect(cls.import).toBeUndefined();
    const overloads = index.entries.filter((e) => e.qualifiedName === 'NavPathStack.pushPathByName');
    expect(overloads.map((e) => [e.kind, e.line, e.since])).toEqual([
      ['method', 39, 10],
      ['method', 50, 11],
    ]);
    expect(overloads[0]!.signature).toBe('pushPathByName(name: string, param: unknown, animated?: boolean): void');
    expect(one(index, 'NavPathStack.constructor').kind).toBe('constructor');
  });

  it('names the kit that re-exports a module symbol and how to import it', () => {
    const push = one(index, 'router.pushUrl');
    expect(push).toMatchObject({
      kind: 'function',
      module: '@ohos.router',
      kit: '@kit.ArkUI',
      import: "import { router } from '@kit.ArkUI'",
      since: 9,
      deprecated: 'since 18',
      deprecatedSince: 18,
      useInstead: 'ohos.arkui.UIContext.Router#pushUrl',
      file: 'ets/api/@ohos.router.d.ts',
    });
    expect(one(index, 'router', 'namespace').signature).toBe('declare namespace router');
    // A member with no @since of its own inherits its parent's.
    const get = one(index, 'preferences.Preferences.get');
    expect(get).toMatchObject({ kind: 'method', kit: '@kit.ArkData', since: 9 });
    expect(one(index, 'preferences.ValueType').kind).toBe('type');
    expect(one(index, 'preferences.removePreferencesFromCacheSync').systemApi).toBe(true);
  });

  it('reports a .d.ets struct as a component, keeping its decorators', () => {
    const bar = one(index, 'DemoBar');
    expect(bar).toMatchObject({
      kind: 'component',
      signature: '@Component export declare struct DemoBar',
      import: "import { DemoBar } from '@kit.ArkUI'",
      // The declaration starts at its decorator.
      line: 14,
    });
    expect(one(index, 'DemoBar.title')).toMatchObject({ kind: 'property', signature: '@Prop title: ResourceStr' });
  });

  it('resolves a built-in component through its interface call signatures', () => {
    expect(one(index, 'Column', 'component')).toMatchObject({
      signature: 'Column(options?: ColumnOptions): ColumnAttribute',
      since: 7,
      global: true,
    });
    expect(index.entries.find((e) => e.name === 'ColumnInstance')).toBeUndefined();
    expect(one(index, 'ColumnAttribute.alignItems').kind).toBe('method');
    expect(one(index, 'FlexDirection.Column')).toMatchObject({ kind: 'enumMember', signature: 'Column = 2' });
  });

  it('reports decorators', () => {
    expect(one(index, 'Local')).toMatchObject({ kind: 'decorator', since: 12, signature: 'declare const Local: PropertyDecorator' });
    expect(one(index, 'ComponentV2').kind).toBe('decorator');
    expect(one(index, 'Provider').kind).toBe('decorator');
    expect(one(index, 'localFunction')).toMatchObject({ kind: 'function', since: 12, sinceText: '12 dynamic, 23 static' });
  });

  it('indexes the Node-API headers', () => {
    const tsfn = index.entries.filter((e) => e.qualifiedName === 'napi_create_threadsafe_function');
    expect(tsfn.map((e) => [e.module, e.line, e.since, e.kit, e.syscap])).toEqual([
      ['node_api.h', 11, undefined, undefined, undefined],
      ['napi/native_api.h', 47, 10, '@kit.ArkTS', 'SystemCapability.ArkUI.ArkUI.Napi'],
    ]);
    expect(tsfn[1]).toMatchObject({
      kind: 'function',
      language: 'c',
      file: 'native/sysroot/usr/include/napi/native_api.h',
      doc: 'Creates a thread-safe function.',
      signature:
        'NAPI_EXTERN napi_status napi_create_threadsafe_function(napi_env env, napi_value func, napi_threadsafe_function* result)',
    });
    expect(one(index, 'NAPI_VERSION')).toMatchObject({ kind: 'macro', signature: '#define NAPI_VERSION 8' });
    expect(one(index, 'NAPI_MODULE_VERSION').kind).toBe('macro');
    expect(index.entries.find((e) => e.name.endsWith('_H_') || e.name.endsWith('_API_H'))).toBeUndefined();
    expect(one(index, 'napi_event_mode')).toMatchObject({ kind: 'enum', since: 12 });
    expect(one(index, 'napi_event_mode_nowait')).toMatchObject({ kind: 'enumMember', signature: 'napi_event_mode_nowait = 1' });
    expect(one(index, 'napi_bigint').kind).toBe('enumMember');
    expect(one(index, 'napi_env').kind).toBe('typedef');
    expect(one(index, 'napi_callback').kind).toBe('typedef');
    expect(one(index, 'napi_property_descriptor').kind).toBe('struct');
    expect(one(index, 'napi_property_descriptor.utf8name').kind).toBe('property');
    expect(one(index, 'napi_property_descriptor.finalize').kind).toBe('property');
  });

  it('loads TypeScript from the SDK, else from node_modules, when none is passed', () => {
    const again = buildApiIndex(SDK18);
    expect(again.entries.length).toBe(index.entries.length);
  });

  it('rejects a directory that is not an SDK', () => {
    expect(() => buildApiIndex(FIXTURES, { typescript: ts })).toThrow(/not an SDK API directory/);
  });
});

describe('rewriteStructs', () => {
  it('keeps positions when turning struct into class', () => {
    const src = '@Component\nexport declare struct DemoBar {\n  // a struct is not a class\n}';
    const r = rewriteStructs(src);
    expect(r.text.length).toBe(src.length);
    expect(r.text).toContain('export declare class  DemoBar');
    expect(r.text).toContain('// a struct is not a class');
    expect([...r.structs]).toEqual(['DemoBar']);
  });
});

describe('native header scanner', () => {
  it('attaches only an adjacent doc block', () => {
    const entries = extractNativeDeclarations(
      '/**\n * @brief Orphan.\n * @since 9\n */\n#include "x.h"\nint a(void);\n/** @since 11 */\nint b(int x);\n',
      'x.h',
      'x.h',
    );
    expect(entries.map((e) => [e.name, e.since])).toEqual([
      ['a', undefined],
      ['b', 11],
    ]);
  });
});

describe('searchApi', () => {
  let index: ApiIndex;
  beforeAll(() => {
    index = buildApiIndex(SDK18, { typescript: ts });
  });

  it('ranks the exact name first, then prefixes, then camelCase parts', () => {
    const r = searchApi(index, 'NavPathStack');
    expect(r.hits[0]).toMatchObject({ qualifiedName: 'NavPathStack', kind: 'class' });
    // Members of the class come after it, on the namespace/class segment.
    expect(r.hits.slice(1).every((h) => h.qualifiedName.startsWith('NavPathStack.'))).toBe(true);
    const push = searchApi(index, 'push').hits.map((h) => h.qualifiedName);
    expect(push).toEqual(['router.pushUrl', 'NavPathStack.pushPathByName']);
    // A camelCase part: the class before its member on the same score.
    const path_ = searchApi(index, 'path').hits.map((h) => h.qualifiedName);
    expect(path_.slice(0, 2)).toEqual(['NavPathStack', 'NavPathStack.pushPathByName']);
  });

  it('groups overloads into one hit', () => {
    const r = searchApi(index, 'pushPathByName');
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ qualifiedName: 'NavPathStack.pushPathByName', overloads: 1, line: 39 });
  });

  it('matches dotted qualified names and ignores a leading @', () => {
    expect(searchApi(index, 'router.pushUrl').hits[0]!.qualifiedName).toBe('router.pushUrl');
    expect(searchApi(index, 'Preferences.get').hits[0]!.qualifiedName).toBe('preferences.Preferences.get');
    expect(searchApi(index, '@Local').hits[0]).toMatchObject({ qualifiedName: 'Local', kind: 'decorator' });
    expect(searchApi(index, 'NavPathStack.pushPathByName()').hits[0]!.qualifiedName).toBe('NavPathStack.pushPathByName');
  });

  it('requires every word to match, in the name or the doc line', () => {
    const r = searchApi(index, 'thread function');
    expect(r.hits.map((h) => h.qualifiedName)).toEqual(['napi_create_threadsafe_function', 'napi_create_threadsafe_function']);
    expect(searchApi(index, 'column alignment').hits[0]!.qualifiedName).toBe('ColumnAttribute.alignItems');
    expect(searchApi(index, 'nosuchthing').total).toBe(0);
  });

  it('filters by kit, kind, language, deprecation and system API', () => {
    expect(normalizeKit('ArkUI')).toBe('@kit.arkui');
    expect(normalizeKit('@kit.ArkData')).toBe('@kit.arkdata');
    expect(searchApi(index, 'get', { kit: 'ArkData' }).hits.map((h) => h.qualifiedName)).toEqual([
      'preferences.Preferences.get',
      'preferences.getPreferences',
    ]);
    expect(searchApi(index, 'Column', { kinds: ['component'] }).hits.map((h) => h.kind)).toEqual(['component']);
    expect(searchApi(index, 'napi_create_threadsafe_function', { language: 'arkts' }).total).toBe(0);
    expect(searchApi(index, 'pushUrl', { noDeprecated: true }).total).toBe(0);
    expect(searchApi(index, 'removePreferencesFromCacheSync', { noSystemApi: true }).total).toBe(0);
    expect(searchApi(index, 'nav', { limit: 1 }).hits).toHaveLength(1);
  });

  it('splits names into camelCase and snake_case parts', () => {
    expect(nameParts('pushPathByName')).toEqual(['push', 'path', 'by', 'name']);
    expect(nameParts('napi_create_object')).toEqual(['napi', 'create', 'object']);
    expect(nameParts('UIAbilityContext')).toEqual(['ui', 'ability', 'context']);
  });
});

describe('showApi and the API level check', () => {
  let i18: ApiIndex;
  let i23: ApiIndex;
  beforeAll(() => {
    i18 = buildApiIndex(SDK18, { typescript: ts });
    i23 = buildApiIndex(SDK23, { typescript: ts });
  });

  it('finds every declaration of an exact qualified name', () => {
    const r = showApi(i18, 'NavPathStack.pushPathByName');
    expect(r.found).toBe(true);
    expect(r.entries.map((e) => e.line)).toEqual([39, 50]);
    expect(showApi(i18, '@Local').entries[0]!.kind).toBe('decorator');
    expect(showApi(i18, 'NavPathStack#pop').found).toBe(true);
  });

  it('falls back to a dotted suffix, and is case-sensitive', () => {
    expect(showApi(i18, 'Preferences.get').entries.map((e) => e.qualifiedName)).toEqual(['preferences.Preferences.get']);
    expect(showApi(i18, 'navpathstack').found).toBe(false);
  });

  it('says a member added after API 18 is missing there and present at 23', () => {
    expect(showApi(i18, 'NavPathStack.getPathStack').found).toBe(false);
    expect(showApi(i23, 'NavPathStack.getPathStack').entries[0]).toMatchObject({ since: 19, line: 31 });
    expect(showApi(i23, 'NavPathStack.clearAll').entries[0]).toMatchObject({ since: 23 });
  });

  it('suggests the real members for a hallucinated one', () => {
    expect(suggestApiSymbols(i18, 'NavPathStack.pushByName')).toEqual(['NavPathStack.pushPathByName']);
    expect(suggestApiSymbols(i18, 'router.navigateTo')).toEqual(['router.pushUrl', 'router.back']);
    expect(suggestApiSymbols(i18, 'pushPathByNam')).toContain('NavPathStack.pushPathByName');
  });
});

describe('index cache', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-api-index-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips through the compact stored form', () => {
    const index = buildApiIndex(SDK18, { typescript: ts });
    const back = deserializeApiIndex(serializeApiIndex(index));
    expect(back).toEqual(index);
  });

  it('builds once, reuses the cache, and rebuilds when the SDK is reinstalled', () => {
    const sdk = path.join(tmp, 'sdk', '18');
    fs.cpSync(SDK18, sdk, { recursive: true });
    const cacheDir = path.join(tmp, 'cache');
    const first = loadApiIndex(sdk, { cacheDir, typescript: ts });
    expect(first.cached).toBe(false);
    expect(first.cachePath).toBe(apiIndexCachePath(cacheDir, sdk));
    expect(fs.existsSync(first.cachePath!)).toBe(true);
    const second = loadApiIndex(sdk, { cacheDir, typescript: ts });
    expect(second.cached).toBe(true);
    expect(second.index.entries).toEqual(first.index.entries);

    const pkg = path.join(sdk, 'ets', 'oh-uni-package.json');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(pkg, later, later);
    expect(loadApiIndex(sdk, { cacheDir, typescript: ts }).cached).toBe(false);
    expect(loadApiIndex(sdk, { cacheDir, typescript: ts }).cached).toBe(true);
    expect(loadApiIndex(sdk, { cacheDir, typescript: ts, rebuild: true }).cached).toBe(false);
  });

  it('rebuilds over a corrupt cache file', () => {
    const cacheDir = path.join(tmp, 'cache');
    const p = apiIndexCachePath(cacheDir, SDK18);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    const r = loadApiIndex(SDK18, { cacheDir, typescript: ts });
    expect(r.cached).toBe(false);
    expect(r.index.entries.length).toBeGreaterThan(0);
  });
});

describe('resolveApiSdk', () => {
  let tmp: string;
  let config: ReturnType<typeof staticConfig>;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-api-sdk-'));
    const home = path.join(tmp, 'sdk', getOsFolder());
    fs.mkdirSync(home, { recursive: true });
    fs.cpSync(SDK18, path.join(home, '18'), { recursive: true });
    fs.cpSync(SDK23, path.join(home, '23'), { recursive: true });
    fs.mkdirSync(path.join(home, 'toolchains-only'));
    config = staticConfig({ sdkRootDir: path.join(tmp, 'sdk') });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists installed API levels, newest first', () => {
    expect(installedApiLevels(config)).toEqual([23, 18]);
  });

  it('prefers --sdk, then --api, then the project, then the newest SDK', () => {
    const home = path.join(tmp, 'sdk', getOsFolder());
    expect(resolveApiSdk(config, { sdkDir: SDK18 })).toEqual({ sdkDir: path.resolve(SDK18), source: 'sdk-option' });
    expect(resolveApiSdk(config, { api: 18 })).toEqual({ sdkDir: path.join(home, '18'), api: 18, source: 'api-option' });
    expect(() => resolveApiSdk(config, { api: 12 })).toThrow(/API 12 SDK is not installed .*installed: 23, 18/);

    const project = path.join(tmp, 'app');
    fs.mkdirSync(path.join(project, 'entry', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'build-profile.json5'),
      "{ app: { products: [{ name: 'default', compileSdkVersion: 18 }] }, modules: [] }",
    );
    // A module's build-profile.json5 names no compileSdkVersion: keep looking upwards.
    fs.writeFileSync(path.join(project, 'entry', 'build-profile.json5'), '{ apiType: "stageMode" }');
    expect(resolveApiSdk(config, { projectDir: path.join(project, 'entry', 'src') })).toEqual({
      sdkDir: path.join(home, '18'),
      api: 18,
      source: 'project',
    });
    expect(resolveApiSdk(config, { projectDir: tmp })).toMatchObject({ api: 23, source: 'newest-installed' });

    fs.writeFileSync(path.join(project, 'build-profile.json5'), '{ app: { products: [{ compileSdkVersion: 12 }] } }');
    const fallback = resolveApiSdk(config, { projectDir: project });
    expect(fallback).toMatchObject({ api: 23, source: 'newest-installed' });
    expect(fallback.note).toMatch(/compiles with API 12, whose SDK is not installed.*API 23/);
  });

  it('names the other installed SDKs that declare a symbol', () => {
    const home = path.join(tmp, 'sdk', getOsFolder());
    const cacheDir = path.join(tmp, 'cache');
    expect(findApiInOtherSdks(config, 'NavPathStack.getPathStack', path.join(home, '18'), { cacheDir })).toEqual([
      { api: 23, since: 19 },
    ]);
    expect(findApiInOtherSdks(config, 'NavPathStack.nothing', path.join(home, '18'), { cacheDir })).toEqual([]);
  });
});
