import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { emulatorHdcAddress } from '../src/emulator/lifecycle.js';
import {
  defaultEmulatorUrl,
  emulatorDownloadUrls,
  hostEmulatorArch,
  installedEmulatorArch,
  isEmulatorInstalled,
} from '../src/emulator/install.js';

describe('isEmulatorInstalled', () => {
  let emulatorDir: string;

  beforeEach(() => {
    emulatorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-emu-'));
    fs.mkdirSync(path.join(emulatorDir, 'images'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(emulatorDir, { recursive: true, force: true });
  });

  const config = () => staticConfig({ emulatorDir });

  it('is false when neither launcher is present', () => {
    expect(isEmulatorInstalled(config())).toBe(false);
  });

  it('is true when images/run.sh is present', () => {
    fs.writeFileSync(path.join(emulatorDir, 'images', 'run.sh'), '#!/bin/sh\n');
    expect(isEmulatorInstalled(config())).toBe(true);
  });

  it('is true when only images/run.bat is present (Windows-only build)', () => {
    fs.writeFileSync(path.join(emulatorDir, 'images', 'run.bat'), '@echo off\n');
    expect(isEmulatorInstalled(config())).toBe(true);
  });
});

describe('emulator architecture', () => {
  it('maps the host CPU to the emulator it runs natively', () => {
    expect(hostEmulatorArch('arm64')).toBe('arm64');
    expect(hostEmulatorArch('x64')).toBe('x86_64');
    expect(hostEmulatorArch('ia32')).toBe('x86_64');
  });

  it('keeps the original asset for x86_64 and names the arm64 one', () => {
    expect(defaultEmulatorUrl('x86_64')).toMatch(/\/oniro_emulator\.zip$/);
    expect(defaultEmulatorUrl('arm64')).toMatch(/\/oniro_emulator_arm64\.zip$/);
  });

  it('lets ONIRO_EMULATOR_URL win over everything', () => {
    expect(emulatorDownloadUrls('https://x/e.zip', 'arm64', 'arm64')).toEqual(['https://x/e.zip']);
  });

  it('tries arm64 then x86_64 on an arm64 host when no arch is asked for', () => {
    expect(emulatorDownloadUrls('', undefined, 'arm64')).toEqual([
      defaultEmulatorUrl('arm64'),
      defaultEmulatorUrl('x86_64'),
    ]);
    expect(emulatorDownloadUrls('', undefined, 'x86_64')).toEqual([defaultEmulatorUrl('x86_64')]);
  });

  it('does not fall back when an arch is asked for', () => {
    expect(emulatorDownloadUrls('', 'arm64', 'x86_64')).toEqual([defaultEmulatorUrl('arm64')]);
  });

  it('reads the installed architecture from the kernel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-emu-'));
    try {
      fs.mkdirSync(path.join(dir, 'images'));
      const config = staticConfig({ emulatorDir: dir });
      expect(installedEmulatorArch(config)).toBeUndefined();
      fs.writeFileSync(path.join(dir, 'images', 'bzImage'), '');
      expect(installedEmulatorArch(config)).toBe('x86_64');
      fs.rmSync(path.join(dir, 'images', 'bzImage'));
      fs.writeFileSync(path.join(dir, 'images', 'Image'), '');
      expect(installedEmulatorArch(config)).toBe('arm64');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('emulatorHdcAddress', () => {
  it('defaults to the launcher default', () => {
    expect(emulatorHdcAddress(undefined)).toBe('127.0.0.1:55555');
  });
  it('dials the --connect address, so a non-default port is waited on', () => {
    expect(emulatorHdcAddress('127.0.0.1:55565')).toBe('127.0.0.1:55565');
  });
  it('dials the loopback for a wildcard bind', () => {
    expect(emulatorHdcAddress('0.0.0.0:55555')).toBe('127.0.0.1:55555');
  });
});
