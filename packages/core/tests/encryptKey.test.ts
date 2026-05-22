import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMaterial, encryptPwd, decryptPwd, getKey } from '../src/sign/encryptKey.js';

describe('encryptKey', () => {
  let materialDir: string;

  beforeEach(() => {
    materialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-test-'));
  });

  afterEach(() => {
    fs.rmSync(materialDir, { recursive: true, force: true });
  });

  it('createMaterial produces the expected directory layout', () => {
    createMaterial(materialDir);
    expect(fs.existsSync(path.join(materialDir, 'fd', '0'))).toBe(true);
    expect(fs.existsSync(path.join(materialDir, 'fd', '1'))).toBe(true);
    expect(fs.existsSync(path.join(materialDir, 'fd', '2'))).toBe(true);
    expect(fs.existsSync(path.join(materialDir, 'ac'))).toBe(true);
    expect(fs.existsSync(path.join(materialDir, 'ce'))).toBe(true);
  });

  it('round-trips a password through encryptPwd/decryptPwd', () => {
    createMaterial(materialDir);
    const original = 'super-secret-123';
    const encrypted = encryptPwd(original, materialDir);
    expect(encrypted).not.toBe(original);
    expect(decryptPwd(encrypted, materialDir)).toBe(original);
  });

  it('getKey returns a 16-byte key', () => {
    createMaterial(materialDir);
    const key = getKey(materialDir);
    expect(key.length).toBe(16);
  });

  it('encrypt produces different ciphertext for the same password each call (random IV)', () => {
    createMaterial(materialDir);
    const a = encryptPwd('hello', materialDir);
    const b = encryptPwd('hello', materialDir);
    expect(a).not.toBe(b);
  });
});
