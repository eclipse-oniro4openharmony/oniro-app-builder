import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { isEmulatorInstalled } from '../src/emulator/install.js';

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
