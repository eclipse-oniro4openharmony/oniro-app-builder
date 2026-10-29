import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CommandFailedError, OniroError, SdkNotInstalledError } from '../src/ports/errors.js';
import { staticConfig } from '../src/ports/config.js';
import { detectInstallFailure, ensureInstallOk } from '../src/hdc/app.js';
import { pickHap } from '../src/build/discoverHaps.js';
import { diagnoseBuildFailure } from '../src/build/buildHap.js';
import { findMissingProjectSdk } from '../src/sdk/detectProjectSdk.js';
import { getOsFolder } from '../src/sdk/platform.js';
import { assertDevicePath, appSandboxDir, normaliseLocalPath } from '../src/hdc/files.js';
import { detectCmdToolsFlavour } from '../src/cmdTools/install.js';

describe('detectInstallFailure', () => {
  it('passes a successful install', () => {
    expect(
      detectInstallFailure('[Info]App install path:C:\\a\\entry-default-unsigned.hap msg:install bundle successfully. \nAppMod finish\n'),
    ).toBeNull();
  });

  it('catches a bundle-manager rejection, which hdc reports with exit code 0', () => {
    const out = '[Info]App install path:C:\\a\\x.hap msg:error: failed to install bundle.\ncode:9568344\nerror: not allow use privilege extension.\n';
    expect(detectInstallFailure(out)).toContain('9568344');
    expect(() => ensureInstallOk({ code: 0, stdout: out, stderr: '' }, 'hdc install x.hap')).toThrow(CommandFailedError);
  });

  it('catches hdc refusing to pick a device', () => {
    expect(detectInstallFailure('[Fail]ExecuteCommand need connect-key? please confirm a device by help info')).not.toBeNull();
  });
});

describe('pickHap', () => {
  const haps = {
    entry: { signed: [], unsigned: ['/p/entry/build/entry-default-unsigned.hap'] },
    watch: { signed: [], unsigned: [] },
  };

  it('falls back to the unsigned HAP and says so', () => {
    expect(pickHap(haps)).toEqual({ module: 'entry', path: '/p/entry/build/entry-default-unsigned.hap', signed: false });
  });

  it('prefers the module that has a signed HAP', () => {
    const mixed = { ...haps, phone: { signed: ['/p/phone-signed.hap'], unsigned: ['/p/phone-unsigned.hap'] } };
    expect(pickHap(mixed)).toEqual({ module: 'phone', path: '/p/phone-signed.hap', signed: true });
  });

  it('is null when nothing is built, and asks for a module when several qualify', () => {
    expect(pickHap({})).toBeNull();
    const two = { a: { signed: ['/a-signed.hap'], unsigned: [] }, b: { signed: ['/b-signed.hap'], unsigned: [] } };
    expect(() => pickHap(two)).toThrow(OniroError);
    expect(pickHap(two, 'b')?.path).toBe('/b-signed.hap');
  });
});

describe('diagnoseBuildFailure', () => {
  it('points system-API errors at the full SDK', () => {
    const out = "ArkTS:ERROR File: Agent.ets:3:10\n 'config' is not exported from Kit '@kit.AccessibilityKit'.";
    expect(diagnoseBuildFailure(out)).toMatch(/full OpenHarmony SDK/);
  });

  it('says nothing about an ordinary compile error', () => {
    expect(diagnoseBuildFailure("ArkTS:ERROR Property 'x' does not exist on type 'Y'.")).toBeUndefined();
  });
});

describe('findMissingProjectSdk', () => {
  let projectDir: string;
  let sdkRoot: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdkcheck-'));
    sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdkroot-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(sdkRoot, { recursive: true, force: true });
  });

  const writeProfile = (product: object): void =>
    fs.writeFileSync(path.join(projectDir, 'build-profile.json5'), JSON.stringify({ app: { products: [product] } }));

  it('names the release to install when the compileSdkVersion SDK is missing', () => {
    writeProfile({ name: 'default', compileSdkVersion: 20, runtimeOS: 'OpenHarmony' });
    const err = findMissingProjectSdk(staticConfig({ sdkRootDir: sdkRoot }), projectDir);
    expect(err).toBeInstanceOf(SdkNotInstalledError);
    expect(err?.version).toBe('6.0');
    expect(err?.message).toMatch(/oniro-app sdk install 6\.0/);
  });

  it('is null once that SDK is installed, or when no numeric compileSdkVersion is declared', () => {
    writeProfile({ name: 'default', compileSdkVersion: 20 });
    fs.mkdirSync(path.join(sdkRoot, getOsFolder(), '20'), { recursive: true });
    expect(findMissingProjectSdk(staticConfig({ sdkRootDir: sdkRoot }), projectDir)).toBeNull();
    writeProfile({ name: 'default', compatibleSdkVersion: '6.0.0(20)' });
    expect(findMissingProjectSdk(staticConfig({ sdkRootDir: sdkRoot }), projectDir)).toBeNull();
  });

  it('accepts an SDK that local.properties sdk.dir points at', () => {
    writeProfile({ name: 'default', compileSdkVersion: 18 });
    const elsewhere = path.join(sdkRoot, 'deveco', 'sdk');
    fs.mkdirSync(path.join(elsewhere, '18'), { recursive: true });
    // Java-properties escaping, as createScaffold writes it on Windows.
    fs.writeFileSync(path.join(projectDir, 'local.properties'), `sdk.dir=${elsewhere.replace(/\\/g, '\\\\')}\n`);
    expect(findMissingProjectSdk(staticConfig({ sdkRootDir: sdkRoot }), projectDir)).toBeNull();
  });
});

describe('device file paths', () => {
  it('rejects a device path a Windows shell rewrote into a host path', () => {
    expect(() => assertDevicePath('C:/Program Files/Git/data/local/tmp/x')).toThrow(/MSYS_NO_PATHCONV/);
    expect(() => assertDevicePath('/data/local/tmp/x')).not.toThrow();
  });

  it('normalises a local path to an absolute native one', () => {
    expect(path.isAbsolute(normaliseLocalPath('some/relative/file.txt'))).toBe(true);
    expect(normaliseLocalPath('x.txt')).toBe(path.join(normaliseLocalPath('.'), 'x.txt'));
  });

  it('maps a bundle to the sandbox hdc shell sees', () => {
    expect(appSandboxDir('com.example.app')).toBe('/data/app/el2/100/base/com.example.app');
  });
});

describe('detectCmdToolsFlavour', () => {
  it('tells HarmonyOS command-line tools by their bundled hms SDK', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cmdtools-'));
    try {
      expect(detectCmdToolsFlavour(dir)).toBe('OpenHarmony');
      fs.mkdirSync(path.join(dir, 'sdk', 'default', 'hms'), { recursive: true });
      expect(detectCmdToolsFlavour(dir)).toBe('HarmonyOS');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
