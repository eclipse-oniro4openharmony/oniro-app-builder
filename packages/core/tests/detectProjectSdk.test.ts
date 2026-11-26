import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectProjectSdk,
  detectProjectSdkVersion,
  findMissingProjectSdk,
  findProjectSdkDir,
  migrateProjectSdkDir,
  resolveProjectSdkDir,
} from '../src/sdk/detectProjectSdk.js';
import { staticConfig } from '../src/ports/config.js';
import { getOsFolder } from '../src/sdk/platform.js';
import { toJavaPropertiesPath } from '../src/sdk/localProperties.js';

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

  it('reads compileSdkVersion from the named product', () => {
    // A project that also targets HarmonyOS: its HarmonyOS product comes first,
    // with the HarmonyOS-style string level, and the OpenHarmony one after it.
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({
        app: {
          products: [
            { name: 'default', targetSdkVersion: '6.0.2(22)', runtimeOS: 'HarmonyOS' },
            { name: 'oniro', compileSdkVersion: 23, runtimeOS: 'OpenHarmony' },
          ],
        },
      }),
    );
    expect(detectProjectSdkVersion(projectDir)).toBeUndefined();
    expect(detectProjectSdkVersion(projectDir, undefined, 'oniro')).toBe(23);
  });

  it('falls back to the first product when the named one is not declared', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', compileSdkVersion: 20 }] } }),
    );
    expect(detectProjectSdkVersion(projectDir, undefined, 'missing')).toBe(20);
  });

  it('does not take an unnamed product for an unnamed request', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', compileSdkVersion: 20 }, { compileSdkVersion: 23 }] } }),
    );
    expect(detectProjectSdkVersion(projectDir)).toBe(20);
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

  it('reads the dotted release an OpenHarmony product declares from API 26', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', compileSdkVersion: '26.0.0', runtimeOS: 'OpenHarmony' }] } }),
    );
    expect(detectProjectSdkVersion(projectDir)).toBe(26);
    expect(detectProjectSdk(projectDir)).toEqual({ api: 26, declared: '26.0.0' });
  });

  it('does not take a HarmonyOS release for an OpenHarmony SDK, dotted or not', () => {
    for (const compileSdkVersion of ['26.0.0', '6.1.1(24)']) {
      fs.writeFileSync(
        path.join(projectDir, 'build-profile.json5'),
        JSON.stringify({ app: { products: [{ name: 'default', compileSdkVersion, runtimeOS: 'HarmonyOS' }] } }),
      );
      expect(detectProjectSdkVersion(projectDir)).toBeUndefined();
    }
  });
});

describe('the SDK an API 26 project builds against', () => {
  let tmp: string;
  let projectDir: string;
  let home: string;
  const config = () => staticConfig({ sdkRootDir: path.join(tmp, 'sdk') });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-detect26-'));
    projectDir = path.join(tmp, 'project');
    home = path.join(tmp, 'sdk', getOsFolder());
    fs.mkdirSync(projectDir);
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', compileSdkVersion: '26.0.0' }] } }),
    );
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const sdk = (folder: string) => {
    const dir = path.join(home, folder);
    fs.mkdirSync(path.join(dir, 'ets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ets', 'oh-uni-package.json'), JSON.stringify({ apiVersion: '26', platformVersion: '26.0.0' }));
    return dir;
  };

  it('is missing until installed, and named where hvigor 6.26 looks', () => {
    expect(findMissingProjectSdk(config(), projectDir)).toMatchObject({
      api: '26',
      version: '7.0',
      expectedPath: path.join(home, '26.0.0'),
    });
    expect(resolveProjectSdkDir(config(), projectDir)).toBeUndefined();
    sdk('26.0.0');
    expect(findMissingProjectSdk(config(), projectDir)).toBeNull();
    expect(resolveProjectSdkDir(config(), projectDir)).toBe(path.join(home, '26.0.0'));
  });

  it('is found in a legacy <api> folder, which migrateProjectSdkDir moves', () => {
    sdk('26');
    expect(findMissingProjectSdk(config(), projectDir)).toBeNull();
    expect(findProjectSdkDir(config(), projectDir)).toMatchObject({ dir: path.join(home, '26'), legacy: true });
    expect(migrateProjectSdkDir(config(), projectDir)).toBe(path.join(home, '26.0.0'));
    expect(findProjectSdkDir(config(), projectDir)).toMatchObject({ dir: path.join(home, '26.0.0'), legacy: false });
    expect(migrateProjectSdkDir(config(), projectDir)).toBeUndefined();
  });

  it('is also found under the sdk.dir local.properties names', () => {
    const other = path.join(tmp, 'deveco-sdk');
    const dir = path.join(other, '26.0.0', 'ets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'local.properties'), `sdk.dir=${toJavaPropertiesPath(other)}\n`);
    expect(resolveProjectSdkDir(config(), projectDir)).toBe(path.join(other, '26.0.0'));
    // Only the oniro-app SDK home is ever rearranged.
    expect(migrateProjectSdkDir(config(), projectDir)).toBeUndefined();
  });
});
