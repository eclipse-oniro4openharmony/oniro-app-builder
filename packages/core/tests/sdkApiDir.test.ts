import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  apiOfDottedVersion,
  compareDottedVersions,
  dottedVersionFor,
  ohosSdkVersionValue,
  usesDottedVersion,
} from '../src/sdk/apiVersion.js';
import {
  apiOfSdkDirName,
  expectedSdkApiDir,
  findSdkApiDir,
  legacySdkApiDirTarget,
  listSdkApiDirs,
  migrateLegacySdkApiDir,
  readOhUniPackage,
  sdkApiDirName,
} from '../src/sdk/apiDir.js';
import { getInstalledSdks, getSupportedSdksForUi } from '../src/sdk/list.js';
import { removeSdk } from '../src/sdk/remove.js';
import { getOsFolder } from '../src/sdk/platform.js';
import { staticConfig } from '../src/ports/config.js';

describe('SDK version formats', () => {
  it('names SDKs by a dotted release from API 26', () => {
    expect(usesDottedVersion(25)).toBe(false);
    expect(usesDottedVersion(26)).toBe(true);
    expect(usesDottedVersion('27')).toBe(true);
  });

  it("reads the API level of a dotted release only in hvigor's own shape", () => {
    expect(apiOfDottedVersion('26.0.0')).toBe(26);
    expect(apiOfDottedVersion(' 27.1.12 ')).toBe(27);
    for (const notDotted of ['25.0.0', '6.1.1', '6.1.1(24)', '26.0.0(26)', '26.0', '26', '26.0.0.39', '../26.0.0']) {
      expect(apiOfDottedVersion(notDotted)).toBeUndefined();
    }
  });

  it('takes an SDK release that names the API level, else <api>.0.0', () => {
    expect(dottedVersionFor(26, '26.0.1')).toBe('26.0.1');
    expect(dottedVersionFor(26, '27.0.0')).toBe('26.0.0');
    expect(dottedVersionFor(26, '6.1.1')).toBe('26.0.0');
    expect(dottedVersionFor(26)).toBe('26.0.0');
  });

  it('declares an OpenHarmony SDK as a number up to API 25 and as its release from 26', () => {
    expect(ohosSdkVersionValue(23, '6.1.0')).toBe(23);
    expect(ohosSdkVersionValue(26)).toBe('26.0.0');
    expect(ohosSdkVersionValue(26, '26.0.1')).toBe('26.0.1');
  });

  it('compares versions part by part', () => {
    expect(compareDottedVersions('6.24.2', '6.26.0')).toBeLessThan(0);
    expect(compareDottedVersions('6.26.4', '6.26.0')).toBeGreaterThan(0);
    expect(compareDottedVersions('6.0.0', '6')).toBe(0);
    expect(compareDottedVersions('5.1.0', '6.0.0')).toBeLessThan(0);
  });
});

describe('SDK API folders', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-apidir-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  /** An SDK folder whose `ets` component names `platformVersion`. */
  const sdk = (name: string, api: string, platformVersion?: string): string => {
    const dir = path.join(home, name);
    fs.mkdirSync(path.join(dir, 'ets'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ets', 'oh-uni-package.json'),
      JSON.stringify({ apiVersion: api, version: `${platformVersion ?? api}.39`, ...(platformVersion ? { platformVersion } : {}) }),
    );
    return dir;
  };

  it('names the folder as hvigor looks for it', () => {
    expect(sdkApiDirName(23, '6.1.0')).toBe('23');
    expect(sdkApiDirName('26', '26.0.0')).toBe('26.0.0');
    expect(sdkApiDirName(26, '../escape')).toBe('26.0.0');
    expect(apiOfSdkDirName('20')).toBe(20);
    expect(apiOfSdkDirName('26.0.0')).toBe(26);
    expect(apiOfSdkDirName('26')).toBe(26);
    expect(apiOfSdkDirName('.temp')).toBeUndefined();
  });

  it('lists SDK folders newest API first, a legacy API 26 folder after the one hvigor reads', () => {
    sdk('20', '20');
    sdk('26', '26', '26.0.0');
    sdk('26.0.1', '26', '26.0.1');
    sdk('26.0.0', '26', '26.0.0');
    fs.mkdirSync(path.join(home, 'licenses'));
    fs.writeFileSync(path.join(home, '23'), 'not a folder');
    expect(listSdkApiDirs(home).map((d) => [path.basename(d.dir), d.api, d.legacy])).toEqual([
      ['26.0.1', 26, false],
      ['26.0.0', 26, false],
      ['26', 26, true],
      ['20', 20, false],
    ]);
    expect(listSdkApiDirs(path.join(home, 'absent'))).toEqual([]);
  });

  it('finds the release a project declares, or a legacy folder holding it', () => {
    sdk('26', '26', '26.0.0');
    expect(findSdkApiDir(home, 26)).toMatchObject({ dir: path.join(home, '26'), legacy: true });
    expect(findSdkApiDir(home, 26, '26.0.0')).toMatchObject({ dir: path.join(home, '26'), legacy: true });
    expect(findSdkApiDir(home, 26, '26.0.1')).toBeUndefined();
    sdk('26.0.0', '26', '26.0.0');
    expect(findSdkApiDir(home, 26, '26.0.0')).toMatchObject({ dir: path.join(home, '26.0.0'), legacy: false });
    expect(findSdkApiDir(home, 26)).toMatchObject({ dir: path.join(home, '26.0.0'), legacy: false });
    expect(findSdkApiDir(home, 20)).toBeUndefined();
  });

  it('names where a missing SDK belongs', () => {
    expect(expectedSdkApiDir(home, 20)).toBe(path.join(home, '20'));
    expect(expectedSdkApiDir(home, 26)).toBe(path.join(home, '26.0.0'));
    expect(expectedSdkApiDir(home, 26, '26.0.1')).toBe(path.join(home, '26.0.1'));
  });

  it("reads the components' metadata", () => {
    expect(readOhUniPackage(sdk('26.0.0', '26', '26.0.0'))).toEqual({
      apiVersion: '26',
      platformVersion: '26.0.0',
      version: '26.0.0.39',
    });
    expect(readOhUniPackage(path.join(home, 'absent'))).toEqual({});
  });

  it('moves a legacy API 26 folder to its release folder', () => {
    sdk('26', '26', '26.0.1');
    const infos: string[] = [];
    const logger = { debug() {}, info: (m: string) => infos.push(m), warn() {}, error() {} };
    expect(migrateLegacySdkApiDir(home, 26, { logger })).toBe(path.join(home, '26.0.1'));
    expect(fs.readdirSync(home)).toEqual(['26.0.1']);
    expect(infos).toEqual([expect.stringMatching(/Moved the API 26 SDK from .*26 to .*26\.0\.1/)]);
    expect(migrateLegacySdkApiDir(home, 26)).toBeUndefined();
  });

  it('leaves folders alone when there is nothing to move or the target is taken', () => {
    sdk('23', '23');
    expect(migrateLegacySdkApiDir(home, 23)).toBeUndefined();
    sdk('26', '26', '26.0.0');
    sdk('26.0.0', '26', '26.0.0');
    expect(migrateLegacySdkApiDir(home, 26)).toBeUndefined();
    expect(fs.readdirSync(home).sort()).toEqual(['23', '26', '26.0.0']);
  });

  it('moves a legacy folder whose components name no release to the one the project declares', () => {
    sdk('26', '26');
    expect(findSdkApiDir(home, 26, '26.0.1')).toMatchObject({ legacy: true });
    expect(legacySdkApiDirTarget(home, 26)).toBe(path.join(home, '26.0.0'));
    expect(legacySdkApiDirTarget(home, 26, '26.0.1')).toBe(path.join(home, '26.0.1'));
    expect(legacySdkApiDirTarget(home, 26, '27.0.0')).toBe(path.join(home, '26.0.0'));
    expect(migrateLegacySdkApiDir(home, 26, { declared: '26.0.1' })).toBe(path.join(home, '26.0.1'));
    expect(findSdkApiDir(home, 26, '26.0.1')).toMatchObject({ dir: path.join(home, '26.0.1'), legacy: false });
  });

  it.skipIf(process.platform === 'win32')('does not count a symlinked API 26 folder, which hvigor 6.26 skips, and replaces it when migrating', () => {
    sdk('26', '26', '26.0.0');
    sdk('real-23', '23');
    fs.symlinkSync(path.join(home, '26'), path.join(home, '26.0.0'));
    fs.symlinkSync(path.join(home, 'real-23'), path.join(home, '23'));
    expect(listSdkApiDirs(home).map((d) => [path.basename(d.dir), d.legacy])).toEqual([
      ['26', true],
      ['23', false],
    ]);
    expect(findSdkApiDir(home, 26, '26.0.0')).toMatchObject({ dir: path.join(home, '26'), legacy: true });
    const infos: string[] = [];
    const logger = { debug() {}, info: (m: string) => infos.push(m), warn() {}, error() {} };
    expect(migrateLegacySdkApiDir(home, 26, { logger })).toBe(path.join(home, '26.0.0'));
    expect(fs.lstatSync(path.join(home, '26.0.0')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(home, '26'))).toBe(false);
    expect(infos[0]).toMatch(/Removed .*26\.0\.0, a link to .*26 that hvigor 6\.26 does not follow/);
    // A link to anything else is left alone.
    sdk('26', '26', '26.0.0');
    fs.renameSync(path.join(home, '26.0.0'), path.join(home, 'elsewhere'));
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, '26.0.0'));
    expect(migrateLegacySdkApiDir(home, 26)).toBeUndefined();
    expect(fs.lstatSync(path.join(home, '26.0.0')).isSymbolicLink()).toBe(true);
  });
});

describe('sdk list and remove with release folders', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdklist-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = () => staticConfig({ sdkRootDir: root });
  const folder = (name: string) => fs.mkdirSync(path.join(root, getOsFolder(), name, 'ets'), { recursive: true });

  it('lists an API 26 SDK as installed in either folder', () => {
    folder('20');
    folder('26.0.0');
    expect(getInstalledSdks(config()).sort()).toEqual(['6.0', '7.0']);
    const installed = Object.fromEntries(getSupportedSdksForUi(config()).map((s) => [s.api, s.installed]));
    expect(installed).toMatchObject({ '20': true, '23': false, '26': true });
    fs.renameSync(path.join(root, getOsFolder(), '26.0.0'), path.join(root, getOsFolder(), '26'));
    expect(getSupportedSdksForUi(config()).find((s) => s.api === '26')!.installed).toBe(true);
  });

  it('removes every folder of an API level, by its level or its release', () => {
    folder('20');
    folder('26');
    folder('26.0.0');
    expect(removeSdk(config(), '26')).toBe(true);
    expect(fs.readdirSync(path.join(root, getOsFolder()))).toEqual(['20']);
    folder('26.0.0');
    expect(removeSdk(config(), '26.0.0')).toBe(true);
    expect(removeSdk(config(), '26')).toBe(false);
    expect(removeSdk(config(), '../20')).toBe(false);
    expect(fs.readdirSync(path.join(root, getOsFolder()))).toEqual(['20']);
  });

  it('removes only the release named, in its own folder or the legacy one', () => {
    const home = path.join(root, getOsFolder());
    const release = (name: string, platformVersion: string) => {
      folder(name);
      fs.writeFileSync(path.join(home, name, 'ets', 'oh-uni-package.json'), JSON.stringify({ apiVersion: '26', platformVersion }));
    };
    release('26.0.0', '26.0.0');
    release('26.0.1', '26.0.1');
    expect(removeSdk(config(), '26.0.0')).toBe(true);
    expect(fs.readdirSync(home)).toEqual(['26.0.1']);
    expect(removeSdk(config(), '26.0.0')).toBe(false);
    release('26', '26.0.0');
    expect(removeSdk(config(), '26.0.1')).toBe(true);
    expect(fs.readdirSync(home)).toEqual(['26']);
    expect(removeSdk(config(), '26.0.0')).toBe(true);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
