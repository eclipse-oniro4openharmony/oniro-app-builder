import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { staticConfig } from '../src/ports/config.js';
import { getOsFolder } from '../src/sdk/platform.js';
import { findSdkOsDir, installSdkFromArchive } from '../src/sdk/install.js';
import { makeStoredZip } from './_helpers/storedZip.js';

const osFolder = getOsFolder();

/** A component ZIP as the SDK ships it: `<name>/oh-uni-package.json` plus a marker naming its OS folder. */
function component(name: string, folder: string, apiVersion: string): Buffer {
  return makeStoredZip([
    { name: `${name}/oh-uni-package.json`, data: Buffer.from(JSON.stringify({ apiVersion, version: `${apiVersion}.0.0.39` })) },
    { name: `${name}/os.txt`, data: Buffer.from(folder) },
  ]);
}

describe('installSdkFromArchive', () => {
  let dir: string;
  let sdkRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdkarchive-'));
    sdkRoot = path.join(dir, 'sdk-root');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A tarball shaped like the daily-build full SDK: `manifest_tag.xml` beside
   * `ohos-sdk/<folder>/<component>-….zip` for each folder.
   */
  async function makeArchive(folders: string[], apiVersion = '26'): Promise<string> {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'manifest_tag.xml'), '<manifest/>');
    for (const folder of folders) {
      const osDir = path.join(src, 'ohos-sdk', folder);
      fs.mkdirSync(osDir, { recursive: true });
      for (const name of ['toolchains', 'ets']) {
        fs.writeFileSync(path.join(osDir, `${name}-${folder}-x64-Release.zip`), component(name, folder, apiVersion));
      }
    }
    const archive = path.join(dir, 'ohos-sdk-full.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: src }, ['manifest_tag.xml', 'ohos-sdk']);
    return archive;
  }

  const allFolders = [...new Set(['linux', 'ohos', 'windows', osFolder])];

  it("installs this OS's components at the API level the archive declares", async () => {
    const archivePath = await makeArchive(allFolders);
    const installed = await installSdkFromArchive({ config: staticConfig({ sdkRootDir: sdkRoot }), archivePath });

    const expected = path.join(sdkRoot, osFolder, '26');
    expect(installed).toEqual({ api: '26', version: '26.0.0.39', dir: expected });
    expect(fs.readFileSync(path.join(expected, 'ets', 'os.txt'), 'utf8')).toBe(osFolder);
    expect(fs.readFileSync(path.join(expected, 'toolchains', 'os.txt'), 'utf8')).toBe(osFolder);
    expect(fs.readdirSync(expected).sort()).toEqual(['ets', 'toolchains']);
    // Only this OS's folder; the scratch dir is gone once the install finishes.
    expect(fs.readdirSync(sdkRoot)).toEqual([osFolder]);
  });

  it('refuses to replace an installed SDK unless forced', async () => {
    const archivePath = await makeArchive([osFolder]);
    const config = staticConfig({ sdkRootDir: sdkRoot });
    const existing = path.join(sdkRoot, osFolder, '26');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'public.txt'), '');

    await expect(installSdkFromArchive({ config, archivePath })).rejects.toThrow(/already installed.*--force/);
    expect(fs.readdirSync(existing)).toEqual(['public.txt']);

    await installSdkFromArchive({ config, archivePath, force: true });
    expect(fs.readdirSync(existing).sort()).toEqual(['ets', 'toolchains']);
  });

  it('rejects an archive without components for this OS', async () => {
    const archivePath = await makeArchive(['ohos']);
    await expect(
      installSdkFromArchive({ config: staticConfig({ sdkRootDir: sdkRoot }), archivePath }),
    ).rejects.toThrow(`No '${osFolder}' SDK components`);
    expect(fs.existsSync(path.join(sdkRoot, osFolder))).toBe(false);
  });

  it('rejects a non-numeric apiVersion rather than using it as a path', async () => {
    const archivePath = await makeArchive([osFolder], '../escape');
    await expect(
      installSdkFromArchive({ config: staticConfig({ sdkRootDir: sdkRoot }), archivePath }),
    ).rejects.toThrow(/numeric apiVersion/);
    expect(fs.existsSync(path.join(sdkRoot, 'escape'))).toBe(false);
  });

  it('rejects a missing archive', async () => {
    await expect(
      installSdkFromArchive({ config: staticConfig({ sdkRootDir: sdkRoot }), archivePath: path.join(dir, 'nope.tar.gz') }),
    ).rejects.toThrow(/SDK archive not found/);
  });
});

describe('findSdkOsDir', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdkosdir-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds the OS folder of ZIPs at any shallow depth, skipping one without ZIPs', () => {
    fs.mkdirSync(path.join(root, 'windows', 'empty'), { recursive: true });
    const nested = path.join(root, 'pkg', 'ohos-sdk', 'windows');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'ets.zip'), '');
    expect(findSdkOsDir(root, 'windows')).toBe(nested);
    expect(findSdkOsDir(root, 'linux')).toBeUndefined();
  });
});
