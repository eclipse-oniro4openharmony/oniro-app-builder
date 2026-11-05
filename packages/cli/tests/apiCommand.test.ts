import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiEntry } from '@oniroproject/core';
import { apiEntryFacts, describeIndex, formatApiEntry } from '../src/commands/api.js';
import { runCli } from './_helpers/runCli.js';

// The fixture SDK trees live with core's tests.
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'tests', 'fixtures', 'api-sdk');

const entry: ApiEntry = {
  name: 'pushUrl',
  qualifiedName: 'router.pushUrl',
  kind: 'function',
  language: 'arkts',
  module: '@ohos.router',
  kit: '@kit.ArkUI',
  import: "import { router } from '@kit.ArkUI'",
  since: 9,
  deprecated: 'since 18',
  deprecatedSince: 18,
  useInstead: 'ohos.arkui.UIContext.Router#pushUrl',
  syscap: 'SystemCapability.ArkUI.ArkUI.Full',
  file: 'ets/api/@ohos.router.d.ts',
  line: 434,
  signature: 'function pushUrl(options: RouterOptions): Promise<void>',
  doc: 'Navigates to a specified page.',
};

describe('api output', () => {
  it('prints the facts: kind, kit, since, deprecation, system API', () => {
    expect(apiEntryFacts(entry)).toBe(
      'function  @kit.ArkUI  since 9  deprecated since 18, use ohos.arkui.UIContext.Router#pushUrl',
    );
    expect(apiEntryFacts({ ...entry, deprecated: undefined, systemApi: true, sinceText: '12 dynamic', since: 12 })).toBe(
      'function  @kit.ArkUI  since 12 dynamic  systemapi',
    );
  });

  it('prints a hit as name and facts, signature, doc line, then where and how to import it', () => {
    expect(formatApiEntry({ ...entry, overloads: 3 }, '/sdk/20')).toBe(
      [
        'router.pushUrl  function  @kit.ArkUI  since 9  deprecated since 18, use ohos.arkui.UIContext.Router#pushUrl',
        '  function pushUrl(options: RouterOptions): Promise<void>   (+3 overloads)',
        '  Navigates to a specified page.',
        `  ${path.join('/sdk/20', 'ets/api/@ohos.router.d.ts')}:434  @ohos.router  import { router } from '@kit.ArkUI'  ` +
          'SystemCapability.ArkUI.ArkUI.Full',
      ].join('\n'),
    );
    const global = { ...entry, import: undefined, global: true, doc: undefined, syscap: undefined };
    expect(formatApiEntry(global, '/sdk').split('\n')).toHaveLength(3);
    expect(formatApiEntry(global, '/sdk')).toContain('global, no import');
  });

  it('names the SDK by API level and version', () => {
    expect(describeIndex({ api: 20, sdkVersion: '6.0.0.47', sdkDir: '/x' })).toBe('API 20 (6.0.0.47)');
    expect(describeIndex({ sdkDir: '/x' })).toBe('/x');
  });
});

describe('oniro-app api (fixture SDK)', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-api-cli-'));
    // An empty SDK root, so only --sdk is ever read.
    env = { ONIRO_CACHE_DIR: path.join(tmp, 'cache'), ONIRO_SDK_ROOT_DIR: path.join(tmp, 'sdk') };
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('search prints ranked JSON hits with the absolute path, and exits 1 on no match', () => {
    const r = runCli(['api', 'search', 'pushPathByName', '--sdk', path.join(FIXTURES, '18'), '--json'], env);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { sdk: { api: number; source: string }; total: number; hits: Array<Record<string, unknown>> };
    expect(out.sdk).toMatchObject({ api: 18, source: 'sdk-option' });
    expect(out.total).toBe(1);
    expect(out.hits[0]).toMatchObject({
      qualifiedName: 'NavPathStack.pushPathByName',
      kind: 'method',
      kit: '@kit.ArkUI',
      since: 10,
      overloads: 1,
      path: path.join(FIXTURES, '18', 'ets', 'component', 'navigation.d.ts'),
    });
    expect(runCli(['api', 'search', 'nosuchsymbolatall', '--sdk', path.join(FIXTURES, '18')], env).status).toBe(1);
  });

  it('show exits 0 when the member is declared and 1 when not, with close matches', () => {
    const sdk18 = path.join(FIXTURES, '18');
    const found = runCli(['api', 'show', 'NavPathStack.pushPathByName', '--sdk', sdk18], env);
    expect(found.status).toBe(0);
    expect(found.stdout).toContain('NavPathStack.pushPathByName is declared in API 18 (5.1.0.107) (2 declarations).');

    const missing = runCli(['api', 'show', 'NavPathStack.getPathStack', '--sdk', sdk18, '--json'], env);
    expect(missing.status).toBe(1);
    const out = JSON.parse(missing.stdout) as { found: boolean; suggestions: string[]; alsoIn: unknown[] };
    expect(out.found).toBe(false);
    expect(out.alsoIn).toEqual([]);
    expect(out.suggestions).toContain('NavPathStack.pushPathByName');

    const at23 = runCli(['api', 'show', 'NavPathStack.getPathStack', '--sdk', path.join(FIXTURES, '23')], env);
    expect(at23.status).toBe(0);
    expect(at23.stdout).toContain('since 19');
  });

  it('rejects a bad --api and an unknown --kind', () => {
    expect(runCli(['api', 'search', 'x', '--api', 'abc'], env).stderr).toMatch(/--api expects an API level/);
    const kind = runCli(['api', 'search', 'x', '--sdk', path.join(FIXTURES, '18'), '--kind', 'widget'], env);
    expect(kind.status).toBe(1);
    expect(kind.stderr).toMatch(/Unknown --kind "widget"/);
  });
});
