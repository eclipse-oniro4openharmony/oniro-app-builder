import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listModules } from '../src/project/listModules.js';
import { listAbilities } from '../src/project/abilities.js';

describe('listModules', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-mods-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('reads modules[] from build-profile.json5', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({
        modules: [
          { name: 'entry', srcPath: './entry', targets: [{ name: 'default' }] },
          { name: 'phone_x', srcPath: './phone_x' },
          { srcPath: './nameless' },
        ],
      }),
    );
    expect(listModules({ projectDir })).toEqual([
      { name: 'entry', srcPath: './entry', targets: ['default'] },
      { name: 'phone_x', srcPath: './phone_x', targets: [] },
    ]);
  });

  it('throws when build-profile.json5 is missing', () => {
    expect(() => listModules({ projectDir })).toThrow(/build-profile\.json5 not found/);
  });
});

describe('listAbilities', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-abil-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('reads module.abilities[] (filtering nameless entries)', () => {
    fs.mkdirSync(path.join(projectDir, 'entry', 'src', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'entry', 'src', 'main', 'module.json5'),
      JSON.stringify({
        module: {
          abilities: [
            { name: 'EntryAbility', type: 'page', visible: true, srcEntry: './ets/EntryAbility.ets' },
            { name: 'BgAbility', visible: false },
            { type: 'service' },
          ],
        },
      }),
    );
    const abilities = listAbilities({ projectDir });
    expect(abilities).toHaveLength(2);
    expect(abilities[0]).toEqual({ name: 'EntryAbility', type: 'page', visible: true, srcEntry: './ets/EntryAbility.ets' });
    expect(abilities[1]!.name).toBe('BgAbility');
    expect(abilities[1]!.visible).toBe(false);
  });

  it('throws when module.json5 is missing', () => {
    expect(() => listAbilities({ projectDir })).toThrow(/Could not find module\.json5/);
  });
});
