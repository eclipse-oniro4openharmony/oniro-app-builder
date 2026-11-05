import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanEts } from '../src/screens/etsScanner.js';
import { inventoryScreens, type ScreensInventory } from '../src/screens/screens.js';
import { checkScreensAgainstSpec, pagesMatching } from '../src/screens/specCheck.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => path.join(here, 'fixtures', 'screens', name);
const template = (name: string): string => path.join(here, '..', '..', 'cli', 'templates', name);

const page = (inv: ScreensInventory, name: string) => inv.pages.find((p) => p.name === name);

describe('scanEts', () => {
  it('keeps comments, strings, templates and regex literals out of the code tokens', () => {
    const s = scanEts(
      [
        "const re = /a\\/b{1}/g; // TODO: one",
        "let t = `x ${ { a: '}' }.a } y`; /* FIXME",
        "two */ struct A { build() { Text('// no') } }",
      ].join('\n'),
    );
    expect(s.comments.map((c) => [c.line, c.text.slice(0, 7)])).toEqual([
      [1, '// TODO'],
      [2, '/* FIXM'],
    ]);
    expect(s.tokens.find((t) => t.kind === 'regex')?.value).toBe('/a\\/b{1}/g');
    expect(s.tokens.find((t) => t.kind === 'template')?.text).toBe('x   y');
    expect(s.tokens.find((t) => t.kind === 'string' && t.text === '// no')?.line).toBe(3);
    const a = s.declarations.find((d) => d.name === 'A');
    expect(a?.kind).toBe('struct');
    expect(s.tokens[a!.bodyClose]?.value).toBe('}');
  });

  it('reads decorators, with and without arguments, before export', () => {
    const s = scanEts("@Entry({ routeName: 'x' })\n@ComponentV2\nexport struct P { build() {} }");
    expect(s.declarations[0]?.decorators.map((d) => d.name)).toEqual(['Entry', 'ComponentV2']);
  });
});

describe('inventoryScreens on the templates', () => {
  for (const name of ['EmptyAbility', 'NativeCpp', 'HarmonyOSApp']) {
    it(`${name}: one @Entry page with one content node, the loadContent route, the Hello World text`, () => {
      const inv = inventoryScreens({ projectDir: template(name) });
      expect(inv.modules).toEqual(['entry']);
      expect(inv.pages).toEqual([
        {
          name: 'pages/Index',
          module: 'entry',
          file: 'entry/src/main/ets/pages/Index.ets',
          line: expect.any(Number),
          component: 'Index',
          entry: true,
          kind: 'entry',
          registered: true,
          contentNodes: 1,
          routesOut: [],
        },
      ]);
      expect(inv.routes).toEqual([
        expect.objectContaining({ from: 'EntryAbility', to: 'pages/Index', via: 'loadContent' }),
      ]);
      expect(inv.placeholders).toEqual([
        expect.objectContaining({ file: 'entry/src/main/ets/pages/Index.ets', text: 'Hello World', kind: 'text' }),
      ]);
      expect(inv.warnings).toEqual([]);
    });
  }
});

describe('inventoryScreens with Navigation, NavDestination and a route map', () => {
  const inv = inventoryScreens({ projectDir: fixture('nav-app') });

  it('reads every module of build-profile.json5', () => {
    expect(inv.modules).toEqual(['entry', 'feature']);
  });

  it('counts content through custom components, @Builders and ForEach, without containers', () => {
    // Header (Text, Image) + ForEach Text + 4 Buttons + Badge builder + footer (Text, Image).
    expect(page(inv, 'pages/Index')).toMatchObject({ kind: 'entry', entry: true, component: 'Index', contentNodes: 10 });
    // Blank and Divider are layout, not content.
    expect(page(inv, 'pages/About')?.contentNodes).toBe(3);
  });

  it('finds the destinations a .navDestination() builder dispatches on, through constants', () => {
    expect(page(inv, 'Detail')).toMatchObject({
      kind: 'navDestination',
      component: 'DetailPage',
      file: 'entry/src/main/ets/pages/Detail.ets',
      registered: true,
      contentNodes: 6,
      routesOut: ['Settings'],
    });
    expect(page(inv, 'Profile')).toMatchObject({ component: 'ProfilePage', contentNodes: 1 });
  });

  it('finds route-map destinations in another module', () => {
    expect(page(inv, 'Settings')).toMatchObject({
      module: 'feature',
      kind: 'navDestination',
      component: 'SettingsPage',
      file: 'feature/src/main/ets/pages/Settings.ets',
      contentNodes: 4,
      routesOut: ['Detail'],
    });
  });

  it('lists a NavDestination struct nothing registers as unregistered', () => {
    expect(page(inv, 'OrphanPage')).toMatchObject({ registered: false, contentNodes: 0 });
  });

  it('attributes routes to pages and includes those of the components a page renders', () => {
    const fromIndex = inv.routes.filter((r) => r.from === 'pages/Index').map((r) => [r.to, r.via]);
    expect(fromIndex).toEqual([
      ['Detail', 'pushPathByName'],
      ['Profile', 'pushPath'],
      ['pages/About', 'pushUrl'],
      ['Settings', 'pushPathByName'],
    ]);
    expect(inv.routes).toContainEqual({
      from: 'Header',
      to: 'pages/About',
      file: 'entry/src/main/ets/components/Header.ets',
      line: 15,
      via: 'replaceUrl',
    });
    expect(inv.routes).toContainEqual(expect.objectContaining({ from: 'Settings', to: 'Detail', via: 'pushPath' }));
    expect(inv.routes).toContainEqual(expect.objectContaining({ from: 'Detail', via: 'replacePathByName', dynamic: true }));
    expect(new Set(page(inv, 'pages/Index')?.routesOut)).toEqual(new Set(['pages/About', 'Detail', 'Profile', 'Settings']));
  });

  it('reports placeholders: TODO comments, placeholder text, string resources, empty and content-less builds', () => {
    expect(inv.placeholders.map((p) => [p.kind, p.file.split('/').pop(), p.text])).toEqual([
      ['empty-build', 'Header.ets', 'empty build() in Spacer'],
      ['no-content', 'Orphan.ets', 'page OrphanPage renders no content nodes'],
      ['comment', 'Profile.ets', 'TODO: real profile layout'],
      ['text', 'Profile.ets', 'Coming soon'],
      ['resource', 'string.json', 'about_body: Lorem ipsum dolor sit amet'],
    ]);
  });

  it('warns about a listed page and a route-map entry whose file is missing', () => {
    expect(inv.warnings).toEqual([
      expect.stringContaining('lists pages/Missing'),
      expect.stringContaining('route Ghost'),
    ]);
  });
});

describe('inventoryScreens with router pages, named routes and a global PageMap', () => {
  const inv = inventoryScreens({ projectDir: fixture('router-app') });

  it('reads router.pushUrl/replaceUrl/pushNamedRoute and pushDestinationByName targets', () => {
    expect(inv.routes.map((r) => [r.from, r.to, r.via])).toEqual([
      // Through local `const options: RouterOptions = { url }` and `const info = new NavPathInfo(...)`.
      ['pages/Home', 'pages/List', 'pushUrl'],
      ['pages/Home', 'Cart', 'pushPath'],
      ['pages/Home', 'pages/List', 'pushUrl'],
      ['pages/Home', 'shared/Named', 'pushNamedRoute'],
      ['pages/Home', 'Cart', 'pushDestinationByName'],
      ['pages/Home', 'pages/Stub', 'replaceUrl'],
    ]);
  });

  it('names a @Entry({ routeName }) page by its route and flags an unlisted @Entry', () => {
    expect(page(inv, 'shared/Named')).toMatchObject({ registered: true, component: 'Named' });
    expect(page(inv, 'pages/Named')).toMatchObject({ registered: false, component: 'Unlisted' });
    expect(inv.warnings).toContainEqual(expect.stringContaining('@Entry Unlisted is not listed'));
  });

  it('dispatches a global @Builder on ==, === and ||, inline NavDestinations included', () => {
    expect(page(inv, 'Cart')).toMatchObject({ component: 'CartPage', contentNodes: 3 }); // LazyForEach x2 + Repeat
    expect(page(inv, 'Checkout')).toMatchObject({ component: null, contentNodes: 1 });
    expect(page(inv, 'Pay')).toMatchObject({ component: null, contentNodes: 1 });
    expect(inv.warnings.some((w) => w.includes('PageMap'))).toBe(false);
  });

  it('flags the empty build() once and counts a ForEach with an if inside', () => {
    expect(inv.placeholders.filter((p) => p.file.endsWith('Stub.ets')).map((p) => p.kind)).toEqual(['empty-build']);
    expect(page(inv, 'pages/List')?.contentNodes).toBe(4); // Search, Text, Text in ForEach/if, Button
    // `toString(16)` is not a route call (an Object.prototype key).
    expect(inv.routes.some((r) => r.via === 'toString')).toBe(false);
    expect(inv.placeholders.some((p) => p.text === 'Find a row')).toBe(false);
  });
});

describe('inventoryScreens errors', () => {
  it('throws for a directory that is not a project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-screens-'));
    try {
      expect(() => inventoryScreens({ projectDir: dir })).toThrow(/build-profile\.json5 not found/);
      expect(() => inventoryScreens({ projectDir: path.join(dir, 'nope') })).toThrow(/not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkScreensAgainstSpec (G2)', () => {
  const inv = inventoryScreens({ projectDir: fixture('nav-app') });

  it('matches screens by route name, last path segment or component, ignoring case', () => {
    expect(pagesMatching(inv, 'about').map((p) => p.name)).toEqual(['pages/About']);
    expect(pagesMatching(inv, 'DetailPage').map((p) => p.name)).toEqual(['Detail']);
    expect(pagesMatching(inv, 'pages/Index').map((p) => p.name)).toEqual(['pages/Index']);
  });

  it('passes when every screen has enough content and every route a call site', () => {
    const report = checkScreensAgainstSpec(inv, {
      screens: ['Index', 'Detail', 'Settings', { name: 'About', minContentNodes: 3 }],
      routes: [
        { from: 'Index', to: 'Detail' },
        { from: 'Index', to: 'About' },
        { from: 'Detail', to: 'Settings' },
        { to: 'pages/About' },
        { from: 'Settings', to: 'DetailPage' },
      ],
      minContentNodes: 2,
    });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.routes[0]?.site).toEqual({
      from: 'pages/Index',
      to: 'Detail',
      file: 'entry/src/main/ets/pages/Index.ets',
      line: 35,
      via: 'pushPathByName',
    });
  });

  it('fails a thin screen, a missing screen, a route without a call site, and ignores loadContent', () => {
    const report = checkScreensAgainstSpec(inv, {
      screens: ['Profile', 'Cart'],
      routes: [{ from: 'About', to: 'Index' }, { to: 'Index' }, { from: 'Profile', to: 'Detail' }],
      minContentNodes: 2,
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      'screen Profile: page Profile (entry/src/main/ets/pages/Profile.ets) has 1 content nodes, needs 2',
      'screen Cart: no page',
      'route About -> Index: no push call site',
      'route * -> Index: no push call site',
      'route Profile -> Detail: no call site from Profile',
    ]);
  });

  it('is pure: an empty spec passes and the inventory is not modified', () => {
    const before = JSON.stringify(inv);
    expect(checkScreensAgainstSpec(inv, {})).toEqual({ ok: true, screens: [], routes: [], failures: [] });
    checkScreensAgainstSpec(inv, { screens: ['Index'], routes: [{ to: 'Detail' }] });
    expect(JSON.stringify(inv)).toBe(before);
  });
});
