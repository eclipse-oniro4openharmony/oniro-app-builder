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
function component(name: string, folder: string, apiVersion: string, platformVersion?: string): Buffer {
  const pkg = { apiVersion, version: `${apiVersion}.0.0.39`, ...(platformVersion ? { platformVersion } : {}) };
  return makeStoredZip([
    { name: `${name}/oh-uni-package.json`, data: Buffer.from(JSON.stringify(pkg)) },
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
  async function makeArchive(folders: string[], apiVersion = '26', platformVersion: string | undefined = '26.0.0'): Promise<string> {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'manifest_tag.xml'), '<manifest/>');
    for (const folder of folders) {
      const osDir = path.join(src, 'ohos-sdk', folder);
      fs.mkdirSync(osDir, { recursive: true });
      for (const name of ['toolchains', 'ets']) {
        fs.writeFileSync(
          path.join(osDir, `${name}-${folder}-x64-Release.zip`),
          component(name, folder, apiVersion, platformVersion),
        );
      }
    }
    const archive = path.join(dir, 'ohos-sdk-full.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: src }, ['manifest_tag.xml', 'ohos-sdk']);
    return archive;
  }

  const allFolders = [...new Set(['linux', 'ohos', 'windows', osFolder])];

  it("installs this OS's components in the folder hvigor reads for the archive's API level", async () => {
    const archivePath = await makeArchive(allFolders);
    const installed = await installSdkFromArchive({ config: staticConfig({ sdkRootDir: sdkRoot }), archivePath });

    // From API 26, hvigor 6.26 looks for the SDK under its release, not its API level.
    const expected = path.join(sdkRoot, osFolder, '26.0.0');
    expect(installed).toEqual({ api: '26', version: '26.0.0.39', dir: expected });
    expect(fs.readFileSync(path.join(expected, 'ets', 'os.txt'), 'utf8')).toBe(osFolder);
    expect(fs.readFileSync(path.join(expected, 'toolchains', 'os.txt'), 'utf8')).toBe(osFolder);
    expect(fs.readdirSync(expected).sort()).toEqual(['ets', 'toolchains']);
    // Only this OS's folder; the scratch dir is gone once the install finishes.
    expect(fs.readdirSync(sdkRoot)).toEqual([osFolder]);
  });

  it('installs an SDK before API 26 under its API level', async () => {
    const archivePath = await makeArchive([osFolder], '23', '6.1.0');
    const installed = await installSdkFromArchive({ config: staticConfig({ sdkRootDir: sdkRoot }), archivePath });
    expect(installed.dir).toBe(path.join(sdkRoot, osFolder, '23'));
  });

  it('refuses to replace an installed SDK unless forced', async () => {
    const archivePath = await makeArchive([osFolder]);
    const config = staticConfig({ sdkRootDir: sdkRoot });
    const existing = path.join(sdkRoot, osFolder, '26.0.0');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'public.txt'), '');

    await expect(installSdkFromArchive({ config, archivePath })).rejects.toThrow(/already installed.*--force/);
    expect(fs.readdirSync(existing)).toEqual(['public.txt']);

    await installSdkFromArchive({ config, archivePath, force: true });
    expect(fs.readdirSync(existing).sort()).toEqual(['ets', 'toolchains']);
  });

  it('installs another release of an API beside the one installed', async () => {
    const config = staticConfig({ sdkRootDir: sdkRoot });
    fs.mkdirSync(path.join(sdkRoot, osFolder, '26.0.0'), { recursive: true });
    const installed = await installSdkFromArchive({ config, archivePath: await makeArchive([osFolder], '26', '26.0.1') });
    expect(installed.dir).toBe(path.join(sdkRoot, osFolder, '26.0.1'));
    expect(fs.readdirSync(path.join(sdkRoot, osFolder)).sort()).toEqual(['26.0.0', '26.0.1']);
  });

  it('counts an SDK in the legacy <api> folder as installed, and replaces it when forced', async () => {
    const archivePath = await makeArchive([osFolder]);
    const config = staticConfig({ sdkRootDir: sdkRoot });
    const legacy = path.join(sdkRoot, osFolder, '26');
    fs.mkdirSync(legacy, { recursive: true });

    await expect(installSdkFromArchive({ config, archivePath })).rejects.toThrow(`already installed at ${legacy}`);

    await installSdkFromArchive({ config, archivePath, force: true });
    expect(fs.readdirSync(path.join(sdkRoot, osFolder))).toEqual(['26.0.0']);
  });

  it('names the folder <api>.0.0 when the release the components declare is not a plain one for that API', async () => {
    for (const platformVersion of ['../../escape', '27.0.0', undefined]) {
      fs.rmSync(sdkRoot, { recursive: true, force: true });
      const archivePath = await makeArchive([osFolder], '26', platformVersion);
      const installed = await installSdkFromArchive({ config: staticConfig({ sdkRootDir: sdkRoot }), archivePath });
      expect(installed.dir).toBe(path.join(sdkRoot, osFolder, '26.0.0'));
    }
    expect(fs.existsSync(path.join(dir, 'escape'))).toBe(false);
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
