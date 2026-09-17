import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findHarmonyOsSdk, findHarmonyOsTool, requireHarmonyOsSdk } from '../src/harmonyos/sdk.js';
import { findJava } from '../src/harmonyos/java.js';
import { staticConfig } from '../src/ports/config.js';

/** An install at `root` whose `sdk/` names itself `flavour` in sdk-pkg.json. */
function makeInstall(root: string, flavour: 'HarmonyOS' | 'OpenHarmony' | 'none' = 'HarmonyOS'): string {
  const sdkDir = path.join(root, 'sdk');
  fs.mkdirSync(path.join(sdkDir, 'default', 'openharmony'), { recursive: true });
  if (flavour !== 'none') {
    fs.writeFileSync(
      path.join(sdkDir, 'default', 'sdk-pkg.json'),
      JSON.stringify({ data: { displayName: `${flavour} 5.1.0`, platformVersion: '5.1.0', apiVersion: '18' } }),
    );
  }
  return sdkDir;
}

describe('findHarmonyOsSdk', () => {
  let tmp: string;
  // Point autodetection at an empty dir so a real install on this machine cannot interfere.
  const config = (values: Record<string, string>) =>
    staticConfig({ cmdToolsPath: path.join(tmp, 'no-cmdtools'), ...values });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hos-sdk-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts ONIRO_HARMONYOS_SDK_PATH as the install root or its sdk directory', () => {
    const sdkDir = makeInstall(tmp);
    for (const configured of [tmp, sdkDir]) {
      expect(findHarmonyOsSdk({ config: config({ harmonyosSdkPath: configured }) })).toEqual({
        sdkPath: sdkDir,
        installRoot: tmp,
        displayName: 'HarmonyOS 5.1.0',
        version: '5.1.0(18)',
      });
    }
  });

  it('takes a configured path as given, whatever its metadata says', () => {
    makeInstall(tmp, 'none');
    expect(findHarmonyOsSdk({ config: config({ harmonyosSdkPath: tmp }) })?.sdkPath).toBe(path.join(tmp, 'sdk'));
  });

  it('autodetects HarmonyOS command-line tools at cmdToolsPath', () => {
    makeInstall(tmp);
    expect(findHarmonyOsSdk({ config: staticConfig({ cmdToolsPath: tmp }) })?.installRoot).toBe(tmp);
  });

  it('does not mistake the OpenHarmony command-line tools for a HarmonyOS install', () => {
    // Both SDKs share one layout; only the metadata tells them apart.
    makeInstall(tmp, 'OpenHarmony');
    expect(findHarmonyOsSdk({ config: staticConfig({ cmdToolsPath: tmp }) })).toBeNull();
  });

  it('ignores a configured path that holds no SDK', () => {
    expect(findHarmonyOsSdk({ config: config({ harmonyosSdkPath: path.join(tmp, 'absent') }) })).toBeNull();
  });

  it('requireHarmonyOsSdk names the setting to fix', () => {
    expect(() => requireHarmonyOsSdk({ config: config({}) })).toThrow(/ONIRO_HARMONYOS_SDK_PATH/);
  });

  it('finds tools in both install layouts', () => {
    const sdkDir = makeInstall(tmp);
    const sdk = findHarmonyOsSdk({ config: config({ harmonyosSdkPath: sdkDir }) })!;
    const ext = process.platform === 'win32' ? '.bat' : '';
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.writeFileSync(path.join(tmp, 'bin', `ohpm${ext}`), '');
    fs.mkdirSync(path.join(tmp, 'tools', 'hvigor', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tools', 'hvigor', 'bin', `hvigor${ext}`), '');

    expect(findHarmonyOsTool(sdk, 'ohpm')).toBe(path.join(tmp, 'bin', `ohpm${ext}`));
    expect(findHarmonyOsTool(sdk, 'hvigor')).toBe(path.join(tmp, 'tools', 'hvigor', 'bin', `hvigor${ext}`));
    expect(findHarmonyOsTool(sdk, 'codelinter')).toBeNull();
  });
});

describe('findJava', () => {
  let tmp: string;
  const JAVA = process.platform === 'win32' ? 'java.exe' : 'java';
  const install = (dir: string) => {
    fs.mkdirSync(path.join(tmp, dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, dir, 'bin', JAVA), '');
    return path.join(tmp, dir, 'bin', JAVA);
  };
  const sdk = () => ({ sdkPath: path.join(tmp, 'sdk'), installRoot: tmp });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-java-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers JAVA_HOME, then the DevEco Studio JBR, then PATH', () => {
    const fromPath = install('path');
    const jbr = install('jbr');
    const home = install('home');
    const env = { JAVA_HOME: path.join(tmp, 'home'), PATH: path.join(tmp, 'path', 'bin') };
    expect(findJava(sdk(), env)).toBe(home);
    expect(findJava(sdk(), { PATH: env.PATH })).toBe(jbr);
    expect(findJava(undefined, { PATH: env.PATH })).toBe(fromPath);
  });

  it('says how to get a runtime when there is none', () => {
    expect(() => findJava(sdk(), { PATH: '' })).toThrow(/JAVA_HOME/);
  });
});
