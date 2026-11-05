import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatScreens, formatTable } from '../src/commands/screens.js';
import { runCli } from './_helpers/runCli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(here, '..', 'templates', 'EmptyAbility');
const navFixture = path.join(here, '..', '..', 'core', 'tests', 'fixtures', 'screens', 'nav-app');

describe('screens text output', () => {
  it('pads every column but the last', () => {
    expect(formatTable(['A', 'BB', 'C'], [['xxx', 'y', 'zzzz'], ['', '', '']])).toBe('A    BB  C\nxxx  y   zzzz\n');
  });

  it('adds a MODULE column only for a multi-module project and marks unregistered pages', () => {
    const page = {
      name: 'Orphan', module: 'entry', file: 'e/O.ets', line: 2, component: 'Orphan', entry: false,
      kind: 'navDestination' as const, registered: false, contentNodes: 0, routesOut: [],
    };
    const base = { projectDir: '/p', routes: [], placeholders: [], warnings: [] };
    const one = formatScreens({ ...base, modules: ['entry'], pages: [page] });
    expect(one).toContain('Orphan (unregistered)');
    expect(one).not.toContain('MODULE');
    expect(formatScreens({ ...base, modules: ['entry', 'feature'], pages: [page] })).toContain('MODULE');
  });
});

describe('oniro-app screens', () => {
  it('prints the inventory of a template and exits 0', () => {
    const r = runCli(['screens', templateDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^pages\/Index\s+entry\s+Index\s+1\s+-\s+entry\/src\/main\/ets\/pages\/Index\.ets:3$/m);
    expect(r.stdout).toContain('Hello World');
  });

  it('--json prints pages, routes and placeholders of a Navigation project', () => {
    const r = runCli(['screens', navFixture, '--json']);
    expect(r.status).toBe(0);
    const inv = JSON.parse(r.stdout) as {
      pages: Array<{ name: string; kind: string }>;
      routes: Array<{ from: string; to: string; via: string }>;
      placeholders: unknown[];
    };
    expect(inv.pages.filter((p) => p.kind === 'navDestination').map((p) => p.name)).toEqual([
      'Settings', 'Detail', 'Profile', 'OrphanPage',
    ]);
    expect(inv.routes).toContainEqual(expect.objectContaining({ from: 'pages/Index', to: 'Detail', via: 'pushPathByName' }));
    expect(inv.placeholders.length).toBeGreaterThan(0);
  });

  it('exits 1 when the directory is not a project', () => {
    const r = runCli(['screens', here, '--json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: expect.stringMatching(/build-profile\.json5 not found/) });
  });
});
