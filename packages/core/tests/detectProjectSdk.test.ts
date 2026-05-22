import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProjectSdkVersion } from '../src/sdk/detectProjectSdk.js';

describe('detectProjectSdkVersion', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-detect-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('reads compileSdkVersion from the first product', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ compileSdkVersion: 23 }] } }),
    );
    expect(detectProjectSdkVersion(projectDir)).toBe(23);
  });

  it('returns undefined when build-profile.json5 is missing', () => {
    expect(detectProjectSdkVersion(projectDir)).toBeUndefined();
  });

  it('returns undefined when no products are declared', () => {
    fs.writeFileSync(path.join(projectDir, 'build-profile.json5'), JSON.stringify({ app: {} }));
    expect(detectProjectSdkVersion(projectDir)).toBeUndefined();
  });

  it('returns undefined when compileSdkVersion is not a number', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ compileSdkVersion: '23' }] } }),
    );
    expect(detectProjectSdkVersion(projectDir)).toBeUndefined();
  });

  it('parses JSON5 (unquoted keys, trailing commas) the same as strict JSON', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      `{
        // a comment
        app: {
          products: [
            { name: 'default', compileSdkVersion: 20, },
          ],
        },
      }`,
    );
    expect(detectProjectSdkVersion(projectDir)).toBe(20);
  });

  it('returns undefined on malformed JSON5', () => {
    fs.writeFileSync(path.join(projectDir, 'build-profile.json5'), '{ this is not valid');
    expect(detectProjectSdkVersion(projectDir)).toBeUndefined();
  });
});
