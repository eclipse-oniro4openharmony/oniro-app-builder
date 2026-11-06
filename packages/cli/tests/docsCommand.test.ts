import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { noopLogger, noopProgress, staticConfig } from '@oniroproject/core';
import { setRuntime } from '../src/lib/runtime.js';
import { formatDocHit, runDocsSearch, runDocsShow, selectDocs } from '../src/commands/docs.js';
import { ALL_TOOLS, TOOL_NAMES, type ToolContext } from '../src/mcp/tools.js';
import { runCli } from './_helpers/runCli.js';

const REF = 'OpenHarmony-6.1-Release';
let docsRoot: string;
let sdkHome: string;

/** A docs clone of one release and an SDK home with one API 23 SDK whose version names that release. */
beforeAll(() => {
  docsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-docs-cli-'));
  const tree = path.join(docsRoot, REF, 'en', 'application-dev');
  const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.writeFileSync(path.join(tree, rel), text);
  };
  put('ui/arkts-navigation-jump.md', '# Page Routing\n\nRouting with NavPathStack.\n\n## Navigation Stack Acquisition\n\nCall pushPathByName.\n\n## Singleton Navigation\n\nOne stack.\n');
  put('reference/apis-arkdata/errorcode-data-rdb.md', '# RDB Error Codes\n\n## 14800011 Database File Corrupted\n\nThe file is corrupted.\n');
  sdkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdk-home-'));
  const osFolder = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const ets = path.join(sdkHome, osFolder, '23', 'ets');
  fs.mkdirSync(path.join(ets, 'api'), { recursive: true });
  fs.writeFileSync(path.join(ets, 'oh-uni-package.json'), JSON.stringify({ apiVersion: '23', version: '6.1.0.31' }));
  setRuntime({ logger: noopLogger, progress: noopProgress, config: staticConfig({ docsDir: docsRoot, sdkRootDir: sdkHome }) });
});

afterAll(() => setRuntime(null));

describe('docs selection', () => {
  it('picks the release from the SDK version, or takes --ref', () => {
    const sel = selectDocs({ api: '23' });
    expect(sel.ref).toBe(REF);
    expect(sel.dir).toBe(path.join(docsRoot, REF));
    expect(sel.sdk).toMatchObject({ api: 23, version: '6.1.0.31' });
    expect(selectDocs({ ref: 'master' })).toEqual({ ref: 'master', dir: path.join(docsRoot, 'master') });
    // An API level whose SDK is not installed still names a release.
    expect(selectDocs({ api: '26' })).toEqual({ ref: 'OpenHarmony-7.0-Release', dir: path.join(docsRoot, 'OpenHarmony-7.0-Release'), sdk: { api: 26 } });
    expect(() => selectDocs({ sdk: '/nonexistent' })).toThrow(/not an SDK API directory/);
  });

  it('says how to sync when the release is not cloned', () => {
    expect(() => runDocsSearch('x', { ref: 'master' })).toThrow(/docs sync --ref master/);
  });
});

describe('docs search and show', () => {
  it('ranks and formats hits, reads a section', () => {
    const { result, json } = runDocsSearch('Navigation pushPathByName', { api: '23' });
    expect(result.hits[0].path).toBe('ui/arkts-navigation-jump.md');
    expect(formatDocHit(result.hits[0])).toMatch(/^ui\/arkts-navigation-jump\.md {2}— {2}Page Routing\n {2}sections: "Navigation Stack Acquisition" \(line 5\)/);
    expect(json).toMatchObject({ docs: { ref: REF }, total: 1 });
    const shown = runDocsShow('ui/arkts-navigation-jump.md', { api: '23', heading: 'stack acquisition' }).result;
    expect(shown.found && shown.text).toBe('## Navigation Stack Acquisition\n\nCall pushPathByName.\n');
    expect(runDocsShow('ui/nope.md', { api: '23' }).result.found).toBe(false);
  });
});

describe('docs MCP tools', () => {
  const ctx: ToolContext = { projectDir: os.tmpdir() };
  const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;

  it('are listed, read-only, and answer from the clone', async () => {
    expect(TOOL_NAMES).toEqual(expect.arrayContaining(['docs_search', 'docs_show']));
    expect(tool('docs_search').annotations.readOnlyHint).toBe(true);
    const found = await tool('docs_search').call({ query: '14800011', api: 23 }, ctx);
    expect(found.isError).toBeUndefined();
    expect(found.structuredContent).toMatchObject({ total: 1, hits: [{ path: 'reference/apis-arkdata/errorcode-data-rdb.md' }] });
    const shown = await tool('docs_show').call({ path: 'reference/apis-arkdata/errorcode-data-rdb.md', heading: '14800011', api: 23 }, ctx);
    expect(shown.structuredContent).toMatchObject({ found: true, text: '## 14800011 Database File Corrupted\n\nThe file is corrupted.\n' });
    const none = await tool('docs_search').call({ query: 'zzz', api: 23 }, ctx);
    expect(none.isError).toBe(true);
    const unsynced = await tool('docs_search').call({ query: 'x', ref: 'master' }, ctx);
    expect(unsynced.isError).toBe(true);
    expect(unsynced.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('docs sync') });
  });
});

describe('docs CLI', () => {
  it('search prints hits and exits 1 on none; show prints a section', () => {
    const env = { ONIRO_DOCS_DIR: docsRoot, ONIRO_SDK_ROOT_DIR: sdkHome };
    const hit = runCli(['docs', 'search', '--api', '23', 'corrupted'], env);
    expect(hit.status).toBe(0);
    expect(hit.stdout).toContain('reference/apis-arkdata/errorcode-data-rdb.md  —  RDB Error Codes');
    expect(hit.stdout).toContain('1 document match');
    const miss = runCli(['docs', 'search', '--api', '23', 'zzz'], env);
    expect(miss.status).toBe(1);
    expect(miss.stdout).toContain('No document matches');
    const shown = runCli(['docs', 'show', '--api', '23', '--heading', 'Singleton', 'ui/arkts-navigation-jump.md'], env);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toBe('## Singleton Navigation\n\nOne stack.\n\n');
    const json = JSON.parse(runCli(['docs', 'search', '--api', '23', '--json', 'routing'], env).stdout) as { docs: { ref: string }; hits: { path: string }[] };
    expect(json.docs.ref).toBe(REF);
    expect(json.hits[0].path).toBe('ui/arkts-navigation-jump.md');
    const unsynced = runCli(['docs', 'show', '--ref', 'master', 'x.md'], env);
    expect(unsynced.status).not.toBe(0);
    expect(unsynced.stderr).toContain('docs sync --ref master');
  });
});
