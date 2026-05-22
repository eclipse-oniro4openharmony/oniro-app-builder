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
});
