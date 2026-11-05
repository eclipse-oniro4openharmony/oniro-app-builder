import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { signingMismatch } from '../src/build/signingCheck.js';
import { buildWithDiagnostics } from '../src/build/buildHap.js';
import { staticConfig } from '../src/ports/config.js';

/** What a plain `oniro-app sign` writes: no `type`. */
const OPENHARMONY_CONFIG = { name: 'default', material: { certpath: './signatures/OpenHarmonyApplication.cer' } };
/** What `oniro-app sign --harmonyos` writes. */
const HARMONYOS_CONFIG = { name: 'default', type: 'HarmonyOS', material: { certpath: '/home/u/.ohos/config/x.cer' } };

describe('signingMismatch (#19)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-signing-check-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const profile = (products: unknown[], signingConfigs: unknown[]): void => {
    fs.writeFileSync(path.join(dir, 'build-profile.json5'), JSON.stringify({ app: { products, signingConfigs } }));
  };

  it('flags OpenHarmony material on a HarmonyOS product, naming `sign --harmonyos`', () => {
    profile([{ name: 'default', signingConfig: 'default', runtimeOS: 'HarmonyOS' }], [OPENHARMONY_CONFIG]);
    expect(signingMismatch(dir, 'HarmonyOS')).toMatch(
      /^Product 'default' targets HarmonyOS, but its signingConfig 'default' holds OpenHarmony material .*`oniro-app sign --harmonyos`/,
    );
  });

  it('accepts HarmonyOS material on a HarmonyOS product, and OpenHarmony material on an OpenHarmony one', () => {
    profile([{ name: 'default', signingConfig: 'default', runtimeOS: 'HarmonyOS' }], [HARMONYOS_CONFIG]);
    expect(signingMismatch(dir, 'HarmonyOS')).toBeUndefined();
    profile([{ name: 'default', signingConfig: 'default' }], [OPENHARMONY_CONFIG]);
    expect(signingMismatch(dir, 'OpenHarmony')).toBeUndefined();
  });

  it('flags the mirror case: HarmonyOS material on an OpenHarmony product', () => {
    profile([{ name: 'default', signingConfig: 'default' }], [HARMONYOS_CONFIG]);
    expect(signingMismatch(dir, 'OpenHarmony')).toMatch(/targets OpenHarmony, .*HarmonyOS \(AppGallery Connect\) material.*`oniro-app sign`/);
  });

  it('reads the named product, and the signingConfig it names', () => {
    profile(
      [
        { name: 'default', signingConfig: 'default' },
        { name: 'hos', signingConfig: 'hosCfg', runtimeOS: 'HarmonyOS' },
      ],
      [OPENHARMONY_CONFIG, { ...HARMONYOS_CONFIG, name: 'hosCfg' }],
    );
    expect(signingMismatch(dir, 'HarmonyOS', 'hos')).toBeUndefined();
    expect(signingMismatch(dir, 'HarmonyOS', 'default')).toMatch(/signingConfig 'default'/);
  });

  it('says nothing without a signingConfig, or without a readable profile', () => {
    profile([{ name: 'default', runtimeOS: 'HarmonyOS' }], []);
    expect(signingMismatch(dir, 'HarmonyOS')).toBeUndefined();
    profile([{ name: 'default', signingConfig: 'missing', runtimeOS: 'HarmonyOS' }], [OPENHARMONY_CONFIG]);
    expect(signingMismatch(dir, 'HarmonyOS')).toBeUndefined();
    fs.rmSync(path.join(dir, 'build-profile.json5'));
    expect(signingMismatch(dir, 'HarmonyOS')).toBeUndefined();
  });
});

// hvigorw is a stand-in that writes a "signed" HAP, as hvigor's SignHap does with any material.
describe.skipIf(process.platform === 'win32')('a build signed with the other runtime\'s material', () => {
  let tmp: string;
  let projectDir: string;
  let root: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-signing-build-'));
    projectDir = path.join(tmp, 'project');
    root = path.join(tmp, 'hos-tools');
    fs.mkdirSync(path.join(root, 'sdk', 'default', 'openharmony'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'sdk', 'default', 'sdk-pkg.json'),
      JSON.stringify({ data: { displayName: 'HarmonyOS 6.1.1', platformVersion: '6.1.1', apiVersion: '24' } }),
    );
    const out = path.join(projectDir, 'entry', 'build', 'default', 'outputs', 'default');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'bin', 'hvigorw'),
      `#!/bin/sh\nmkdir -p "${out}" && : > "${out}/entry-default-signed.hap"\necho "BUILD SUCCESSFUL"\n`,
      { mode: 0o755 },
    );
    fs.mkdirSync(path.join(projectDir, 'oh_modules'), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('passes, with a warning and a `signing` diagnostic naming `sign --harmonyos`', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({
        app: {
          products: [{ name: 'default', signingConfig: 'default', runtimeOS: 'HarmonyOS', compileSdkVersion: '6.1.1(24)' }],
          signingConfigs: [OPENHARMONY_CONFIG],
        },
      }),
    );
    const report = await buildWithDiagnostics({
      config: staticConfig({ harmonyosSdkPath: root, cmdToolsPath: path.join(tmp, 'absent') }),
      projectDir,
    });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([expect.stringContaining('oniro-app sign --harmonyos')]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', source: 'signing', file: 'build-profile.json5' }),
    ]);
    expect(report.summary.warnings).toBe(1);
  });

  it('stays quiet when the material matches', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({
        app: {
          products: [{ name: 'default', signingConfig: 'default', runtimeOS: 'HarmonyOS', compileSdkVersion: '6.1.1(24)' }],
          signingConfigs: [HARMONYOS_CONFIG],
        },
      }),
    );
    const report = await buildWithDiagnostics({
      config: staticConfig({ harmonyosSdkPath: root, cmdToolsPath: path.join(tmp, 'absent') }),
      projectDir,
    });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.diagnostics).toEqual([]);
  });
});
