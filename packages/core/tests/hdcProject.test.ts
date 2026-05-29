import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getBundleName, getMainAbility } from '../src/hdc/project.js';

describe('getBundleName', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hdc-'));
    fs.mkdirSync(path.join(projectDir, 'AppScope'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns bundleName from AppScope/app.json5', () => {
    fs.writeFileSync(
      path.join(projectDir, 'AppScope', 'app.json5'),
      JSON.stringify({ app: { bundleName: 'com.example.bundle' } }),
    );
    expect(getBundleName(projectDir)).toBe('com.example.bundle');
  });

  it('throws when app.json5 is missing', () => {
    expect(() => getBundleName(projectDir)).toThrow(/Could not find app.json5/);
  });

  it('throws when bundleName is missing', () => {
    fs.writeFileSync(path.join(projectDir, 'AppScope', 'app.json5'), JSON.stringify({ app: {} }));
    expect(() => getBundleName(projectDir)).toThrow(/bundleName not found/);
  });

  it('reads JSON5 with unquoted keys and comments', () => {
    fs.writeFileSync(
      path.join(projectDir, 'AppScope', 'app.json5'),
      `{ /* hi */ app: { bundleName: "com.example.foo" } }`,
    );
    expect(getBundleName(projectDir)).toBe('com.example.foo');
  });
});

describe('getMainAbility', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hdc-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns mainElement from the default `entry` module', () => {
    fs.mkdirSync(path.join(projectDir, 'entry', 'src', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'entry', 'src', 'main', 'module.json5'),
      JSON.stringify({ module: { mainElement: 'EntryAbility' } }),
    );
    expect(getMainAbility(projectDir)).toBe('EntryAbility');
  });

  it('respects a custom module name', () => {
    fs.mkdirSync(path.join(projectDir, 'custom', 'src', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'custom', 'src', 'main', 'module.json5'),
      JSON.stringify({ module: { mainElement: 'OtherAbility' } }),
    );
    expect(getMainAbility(projectDir, 'custom')).toBe('OtherAbility');
  });

  it('throws when module.json5 is missing', () => {
    expect(() => getMainAbility(projectDir)).toThrow(/Could not find module.json5/);
  });

  it('throws when mainElement is missing', () => {
    fs.mkdirSync(path.join(projectDir, 'entry', 'src', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'entry', 'src', 'main', 'module.json5'),
      JSON.stringify({ module: {} }),
    );
    expect(() => getMainAbility(projectDir)).toThrow(/mainElement not found/);
  });

  function writeModule(module: unknown): void {
    fs.mkdirSync(path.join(projectDir, 'entry', 'src', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'entry', 'src', 'main', 'module.json5'),
      JSON.stringify({ module }),
    );
  }

  it('falls back to the first visible ability when mainElement is absent', () => {
    writeModule({
      abilities: [
        { name: 'BackgroundAbility', visible: false },
        { name: 'VisibleAbility', visible: true },
      ],
    });
    expect(getMainAbility(projectDir)).toBe('VisibleAbility');
  });

  it('falls back to the first ability when none are marked visible', () => {
    writeModule({ abilities: [{ name: 'OnlyAbility' }] });
    expect(getMainAbility(projectDir)).toBe('OnlyAbility');
  });

  it('prefers mainElement over abilities[] when both are present', () => {
    writeModule({ mainElement: 'MainAbility', abilities: [{ name: 'OtherAbility', visible: true }] });
    expect(getMainAbility(projectDir)).toBe('MainAbility');
  });

  it('selects an explicitly named ability', () => {
    writeModule({
      mainElement: 'MainAbility',
      abilities: [{ name: 'MainAbility', visible: true }, { name: 'SettingsAbility', visible: true }],
    });
    expect(getMainAbility(projectDir, 'entry', 'SettingsAbility')).toBe('SettingsAbility');
  });

  it('throws when the explicitly named ability does not exist', () => {
    writeModule({ mainElement: 'MainAbility', abilities: [{ name: 'MainAbility' }] });
    expect(() => getMainAbility(projectDir, 'entry', 'NopeAbility')).toThrow(/not found/);
  });
});
