import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { getHvigorwPath, getOhpmPath, getCmdToolsBin } from '../src/sdk/paths.js';

const isWin = process.platform === 'win32';

describe('getHvigorwPath probe-and-fallback', () => {
  let projectDir: string;
  let cmdToolsPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-proj-'));
    cmdToolsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cmdtools-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cmdToolsPath, { recursive: true, force: true });
  });

  const config = () => staticConfig({ cmdToolsPath });

  it('prefers the project-local hvigorw when the hvigor/ install is complete', () => {
    fs.writeFileSync(path.join(projectDir, 'hvigorw'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(projectDir, 'hvigor', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'hvigor', 'hvigor-wrapper.js'), '');
    expect(getHvigorwPath(config(), projectDir)).toBe(path.join(projectDir, 'hvigorw'));
  });

  it('falls back to cmd-tools hvigorw when the local hvigor/ install is incomplete', () => {
    // Wrapper present, but no hvigor/ install → the local wrapper would crash.
    fs.writeFileSync(path.join(projectDir, 'hvigorw'), '#!/bin/sh\n');
    expect(getHvigorwPath(config(), projectDir)).toBe(getCmdToolsBin(config(), 'hvigorw'));
  });

  it('falls back to cmd-tools hvigorw when no project-local wrapper exists', () => {
    expect(getHvigorwPath(config(), projectDir)).toBe(getCmdToolsBin(config(), 'hvigorw'));
  });

  it('requires BOTH the wrapper script and its node_modules', () => {
    fs.writeFileSync(path.join(projectDir, 'hvigorw'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(projectDir, 'hvigor'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'hvigor', 'hvigor-wrapper.js'), '');
    // node_modules missing → still falls back.
    expect(getHvigorwPath(config(), projectDir)).toBe(getCmdToolsBin(config(), 'hvigorw'));
  });
});

describe('getOhpmPath / getCmdToolsBin', () => {
  const config = () => staticConfig({ cmdToolsPath: '/opt/cmdtools' });

  it('getOhpmPath equals getCmdToolsBin(config, "ohpm")', () => {
    expect(getOhpmPath(config())).toBe(getCmdToolsBin(config(), 'ohpm'));
  });

  it('getCmdToolsBin defaults to ohpm', () => {
    expect(getCmdToolsBin(config())).toBe(getCmdToolsBin(config(), 'ohpm'));
  });

  it.skipIf(isWin)('resolves named binaries under <cmdToolsPath>/bin on POSIX', () => {
    expect(getOhpmPath(config())).toBe(path.join('/opt/cmdtools', 'bin', 'ohpm'));
    expect(getCmdToolsBin(config(), 'hvigorw')).toBe(path.join('/opt/cmdtools', 'bin', 'hvigorw'));
    expect(getCmdToolsBin(config(), 'codelinter')).toBe(path.join('/opt/cmdtools', 'bin', 'codelinter'));
  });
});
