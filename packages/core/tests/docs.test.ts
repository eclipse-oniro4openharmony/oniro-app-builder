import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { staticConfig } from '../src/ports/config.js';
import { DocsIndex, docQueryTerms, docTokens, docWords, wordIn } from '../src/docs/search.js';
import {
  DOCS_SPARSE_PATH,
  docsDirFor,
  docsRefFor,
  docsTree,
  getDocsRootDir,
  readSdkRelease,
  syncDocs,
} from '../src/docs/sync.js';

const NAV = `# Page Routing

Navigation-related routing operations are all based on the APIs provided by NavPathStack.

![nav](figures/nav.png)

## Creating a Navigation Page

Create a Navigation root container.

### Navigation Stack Acquisition

Call \`pushPathByName\` on the stack.

\`\`\`ts
this.pathStack.pushPathByName('Detail', id);
\`\`\`

## Singleton Navigation

One stack per app.
`;
const RDB_ERR = `# RDB Error Codes

## 14800011 Database File Corrupted

**Error Message**

Database file corrupted.
`;
const RDB_SYS = `# @ohos.data.relationalStore (RDB Store) (System API)

## RdbStore

insert for system apps.
`;
const RDB = `# Interface (RdbStore)

Provides APIs for managing data in an RDB store.

## insert

insert(table: string, values: ValuesBucket): Promise<number>
`;
const TEXT = `# Text

The Text component displays a piece of text.

## Attributes

### fontSize

Sets the font size.
`;
const README = `# Readme

- relationalStore insert
- Navigation Text fontSize
`;

function fixtureTree(): string {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-docs-'));
  const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.writeFileSync(path.join(tree, rel), text);
  };
  put('ui/arkts-navigation-jump.md', NAV);
  put('reference/apis-arkdata/errorcode-data-rdb.md', RDB_ERR);
  put('reference/apis-arkdata/js-apis-data-relationalStore-sys.md', RDB_SYS);
  put('reference/apis-arkdata/arkts-apis-data-relationalStore-RdbStore.md', RDB);
  put('reference/apis-arkui/arkui-ts/ts-basic-components-text.md', TEXT);
  put('Readme-EN.md', README);
  put('ui/figures/ignored.md', '# not indexed');
  return tree;
}

describe('docs index', () => {
  const idx = DocsIndex.load(fixtureTree());

  it('indexes every Markdown file except figures, once per process', () => {
    expect(idx.size).toBe(6);
    expect(idx.docs.map((d) => d.path)).not.toContain('ui/figures/ignored.md');
    expect(DocsIndex.load(idx.tree)).toBe(idx);
  });

  it('tokenises identifiers, splits camelCase into weaker parts, indexes stems and parts', () => {
    expect(docTokens('this.pathStack.pushPathByName(xy) 1234567890123')).toEqual(['this.pathstack.pushpathbyname', 'xy']);
    const t = docQueryTerms('NavPathStack insert');
    expect(t.find((x) => x.term === 'navpathstack')?.weight).toBe(1);
    expect(t.find((x) => x.term === 'insert')?.weight).toBe(1);
    expect(t.find((x) => x.term === 'stack')?.weight).toBe(0.4);
    expect([...docWords('a/b.md', 'pushPathByName10+ and this.pathStack.pop()')]).toEqual(
      expect.arrayContaining(['pushpathbyname10', 'pushpathbyname', 'pathstack', 'pop']),
    );
    expect(wordIn('insert10+', 'insert')).toBe(true);
    expect(wordIn('sendablerelationalstore', 'relationalstore')).toBe(false);
  });

  it('finds a guide by heading and reports the matching sections', () => {
    const r = idx.search('Navigation pushPathByName');
    expect(r.hits[0].path).toBe('ui/arkts-navigation-jump.md');
    expect(r.hits[0].headings.map((h) => h.text)).toContain('Navigation Stack Acquisition');
    expect(r.hits[0].snippet).toMatch(/^Navigation-related routing/);
    expect(r.hits.map((h) => h.path)).not.toContain('Readme-EN.md');
    expect(r.terms).toContain('pushpathbyname');
  });

  it('finds an error code, ranks the system-API variant below the ordinary one, prefers an exact title', () => {
    expect(idx.search('14800011').hits[0].headings[0].text).toBe('14800011 Database File Corrupted');
    const hits = idx.search('relationalStore insert').hits;
    expect(hits[0].path).toBe('reference/apis-arkdata/arkts-apis-data-relationalStore-RdbStore.md');
    expect(hits.findIndex((h) => h.path.endsWith('-sys.md'))).toBeGreaterThan(0);
    expect(idx.search('Text fontSize').hits[0].path).toBe('reference/apis-arkui/arkui-ts/ts-basic-components-text.md');
  });

  it('requires every word when possible, falls back to any, honours section and limit', () => {
    expect(idx.search('singleton corrupted').total).toBeGreaterThan(0);
    expect(idx.search('zzz-nothing').total).toBe(0);
    expect(idx.search('pushPathByName', { section: 'reference' }).total).toBe(0);
    expect(idx.search('pushPathByName', { section: 'ui' }).hits[0].path).toBe('ui/arkts-navigation-jump.md');
    const r = idx.search('insert', { limit: 1 });
    expect(r.hits).toHaveLength(1);
    expect(r.total).toBeGreaterThan(1);
  });

  it('shows a section between headings, drops images, caps lines and suggests', () => {
    const sec = idx.show('ui/arkts-navigation-jump.md', { heading: 'navigation stack' });
    if (!sec.found) throw new Error(sec.error);
    expect(sec.text).toMatch(/^### Navigation Stack Acquisition/);
    expect(sec.text).toContain("pushPathByName('Detail'");
    expect(sec.text).not.toContain('Singleton');
    const whole = idx.show('en/application-dev/ui/arkts-navigation-jump.md', { maxLines: 20 });
    if (!whole.found) throw new Error(whole.error);
    expect(whole.text).not.toContain('![nav]');
    expect(whole.text).toContain('more lines');
    expect(whole.truncated).toBe(true);
    expect(whole.headings.map((h) => h.text)).toContain('Singleton Navigation');
    const missing = idx.show('ui/arkts-navigation-navigation.md');
    expect(!missing.found && missing.suggestions).toContain('ui/arkts-navigation-jump.md');
    const badHeading = idx.show('ui/arkts-navigation-jump.md', { heading: 'nope' });
    expect(!badHeading.found && badHeading.suggestions).toContain('Singleton Navigation');
    expect(idx.show('../../etc/passwd').found).toBe(false);
  });
});

describe('docs releases and locations', () => {
  it('maps an SDK version, else an API level, to the release branch', () => {
    expect(docsRefFor({ version: '6.1.0.31', api: 23 })).toBe('OpenHarmony-6.1-Release');
    expect(docsRefFor({ version: '5.1.0.107' })).toBe('OpenHarmony-5.1.0-Release');
    expect(docsRefFor({ version: '7.0.0.39' })).toBe('OpenHarmony-7.0-Release');
    expect(docsRefFor({ api: 20 })).toBe('OpenHarmony-6.0-Release');
    expect(docsRefFor({ api: 26 })).toBe('OpenHarmony-7.0-Release');
    expect(docsRefFor({ api: 99 })).toBe('master');
    expect(docsRefFor({})).toBe('master');
  });

  it('reads the SDK release and puts the clones under docsDir, default <sdkRootDir>/docs', () => {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdk-'));
    fs.mkdirSync(path.join(sdk, 'ets'));
    fs.writeFileSync(path.join(sdk, 'ets', 'oh-uni-package.json'), JSON.stringify({ apiVersion: '23', version: '6.1.0.31' }));
    expect(readSdkRelease(sdk)).toEqual({ api: 23, version: '6.1.0.31' });
    expect(readSdkRelease('/nonexistent')).toEqual({});
    expect(getDocsRootDir(staticConfig({ docsDir: '/x/docs' }))).toBe('/x/docs');
    expect(getDocsRootDir(staticConfig({ sdkRootDir: '/sdk' }))).toBe(path.join('/sdk', 'docs'));
    expect(docsDirFor(staticConfig({ docsDir: '/x' }), 'OpenHarmony-6.1-Release')).toBe(path.join('/x', 'OpenHarmony-6.1-Release'));
    expect(docsTree('/nonexistent/dir')).toBeNull();
  });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit)('docs sync', () => {
  it('clones only en/application-dev without figures, then updates in place', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-docs-sync-'));
    const origin = path.join(root, 'origin');
    const git = (args: string[], cwd = origin): string => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    fs.mkdirSync(origin);
    git(['init', '-q', '-b', 'OpenHarmony-6.1-Release']);
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(origin, rel)), { recursive: true });
      fs.writeFileSync(path.join(origin, rel), text);
    };
    put(`${DOCS_SPARSE_PATH}/ui/guide.md`, '# Guide\n\nText.\n');
    put(`${DOCS_SPARSE_PATH}/ui/figures/pic.png`, 'png');
    put(`${DOCS_SPARSE_PATH}/ui/shot.jpg`, 'jpg');
    put('zh-cn/application-dev/ui/guide.md', '# 指南\n');
    put('en/device-dev/kernel.md', '# Kernel\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'one']);
    git(['config', 'uploadpack.allowFilter', 'true']);

    const dir = path.join(root, 'clone');
    const first = await syncDocs({ ref: 'OpenHarmony-6.1-Release', dir, repo: origin });
    expect(first).toMatchObject({ dir, ref: 'OpenHarmony-6.1-Release', files: 1, updated: false });
    expect(first.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(fs.existsSync(path.join(dir, DOCS_SPARSE_PATH, 'ui', 'guide.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, DOCS_SPARSE_PATH, 'ui', 'figures'))).toBe(false);
    expect(fs.existsSync(path.join(dir, DOCS_SPARSE_PATH, 'ui', 'shot.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'zh-cn'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'en', 'device-dev'))).toBe(false);

    put(`${DOCS_SPARSE_PATH}/ui/second.md`, '# Second\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'two']);
    const second = await syncDocs({ ref: 'OpenHarmony-6.1-Release', dir, repo: origin });
    expect(second).toMatchObject({ files: 2, updated: true });
    expect(second.commit).not.toBe(first.commit);
    expect(docsTree(dir)).toBe(path.join(dir, DOCS_SPARSE_PATH));
    const idx = DocsIndex.load(docsTree(dir)!);
    expect(idx.search('second').hits[0].path).toBe('ui/second.md');
  }, 60_000);

  it('fails plainly on a missing branch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-docs-sync-'));
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: origin });
    await expect(syncDocs({ ref: 'nope', dir: path.join(root, 'clone'), repo: origin })).rejects.toThrow(/git clone failed/);
  }, 30_000);
});
