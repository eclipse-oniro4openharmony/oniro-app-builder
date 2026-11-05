import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pickSigningSdk, signOpenHarmonyHap } from '../src/sign/signHap.js';
import { makeStoredZip } from './_helpers/storedZip.js';

// No JDK: stands in for hap-sign-tool. sign-profile records the template it signs;
// sign-app copies the HAP with a marker appended.
const tool = vi.hoisted(() => ({ signedProfile: undefined as Record<string, any> | undefined }));
const fakeHapSignTool = vi.hoisted(() => (_cmd: string, args: string[]) => {
  const arg = (name: string) => args[args.indexOf(name) + 1]!;
  if (args.includes('sign-profile')) {
    tool.signedProfile = JSON.parse(fs.readFileSync(arg('-inFile'), 'utf8'));
    fs.copyFileSync(arg('-inFile'), arg('-outFile'));
  }
  if (args.includes('sign-app')) {
    fs.writeFileSync(arg('-outFile'), Buffer.concat([fs.readFileSync(arg('-inFile')), Buffer.from('SIGNED')]));
  }
  return Buffer.alloc(0);
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  execFileSync: vi.fn(),
}));

const cert = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;

describe('signOpenHarmonyHap', () => {
  let tmp: string;
  let sdkHome: string;
  let hapPath: string;
  const exec = vi.mocked(execFileSync);

  const writeSdk = (api: string) => {
    const lib = path.join(sdkHome, api, 'toolchains', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'hap-sign-tool.jar'), '');
    fs.writeFileSync(path.join(lib, 'OpenHarmony.p12'), '');
    fs.writeFileSync(path.join(lib, 'OpenHarmonyProfileRelease.pem'), cert('ROOT') + cert('CA') + cert(`LEAF-${api}`));
    fs.writeFileSync(
      path.join(lib, 'UnsgnedReleasedProfileTemplate.json'),
      JSON.stringify({ 'bundle-info': { 'bundle-name': 'com.OpenHarmony.app.test', apl: 'normal' }, acls: { 'allowed-acls': [''] } }),
    );
  };
  const writeHap = (app: Record<string, unknown>) =>
    fs.writeFileSync(hapPath, makeStoredZip([{ name: 'module.json', data: Buffer.from(JSON.stringify({ app, module: { name: 'entry' } })) }]));
  const call = (sub: string) => exec.mock.calls.map((c) => c[1] as string[]).find((a) => a.includes(sub))!;
  const arg = (args: string[], name: string) => args[args.indexOf(name) + 1];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-ohsignhap-'));
    sdkHome = path.join(tmp, 'sdk', 'linux');
    writeSdk('20');
    writeSdk('23');
    hapPath = path.join(tmp, 'entry-default-unsigned.hap');
    writeHap({ bundleName: 'com.example.prebuilt', compileSdkType: 'OpenHarmony', targetAPIVersion: 20 });
    exec.mockReset();
    exec.mockImplementation(fakeHapSignTool as never);
    tool.signedProfile = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("signs a copy with the SDK's development material and a profile for the HAP's bundle", async () => {
    const result = await signOpenHarmonyHap({ hapPath, sdkHome });

    const outPath = path.join(tmp, 'entry-default-signed.hap');
    // The SDK the HAP targets, though a newer one is installed.
    expect(result).toEqual({
      bundleName: 'com.example.prebuilt',
      outPath,
      sdkApi: '20',
      kind: 'profile-release',
      // Read back from the material: the stand-in's profile is the bare template, its PEMs not certificates.
      material: { apl: 'normal', profileType: undefined, profileNotAfter: undefined, certificateNotAfter: undefined },
    });
    expect(tool.signedProfile!['bundle-info']).toMatchObject({
      'bundle-name': 'com.example.prebuilt',
      apl: 'normal',
      'app-feature': 'hos_normal_app',
      'distribution-certificate': cert('LEAF-20'),
    });
    const signApp = call('sign-app');
    expect(arg(signApp, '-jar')).toBe(path.join(sdkHome, '20', 'toolchains', 'lib', 'hap-sign-tool.jar'));
    expect(arg(signApp, '-keyAlias')).toBe('openharmony application profile release');
    expect(arg(signApp, '-inFile')).toBe(hapPath);
    expect(path.basename(arg(signApp, '-appCertFile')!)).toBe('OpenHarmonyProfileRelease.pem');
    expect([arg(signApp, '-keyPwd'), arg(signApp, '-keystorePwd')]).toEqual(['123456', '123456']);

    expect(fs.readFileSync(outPath).subarray(-6).toString()).toBe('SIGNED');
    // The input is untouched, and neither the temporary HAP nor the material survives.
    expect(fs.readdirSync(tmp).sort()).toEqual(['entry-default-signed.hap', 'entry-default-unsigned.hap', 'sdk']);
    expect(fs.existsSync(path.dirname(arg(signApp, '-profileFile')!))).toBe(false);
  });

  it('signs a system app with the application-release key, its ACLs and privileges, in place', async () => {
    const result = await signOpenHarmonyHap({
      hapPath,
      outPath: hapPath,
      sdkHome,
      apl: 'system_basic',
      acls: ['ohos.permission.CAPTURE_SCREEN'],
      appPrivilegeCapabilities: ['AllowAppUsePrivilegeExtension'],
      passwords: { store: 's', key: 'k' },
    });

    expect(result).toMatchObject({ outPath: hapPath, kind: 'application-release' });
    expect(tool.signedProfile).toMatchObject({
      'bundle-info': { apl: 'system_basic', 'app-feature': 'hos_system_app' },
      acls: { 'allowed-acls': ['ohos.permission.CAPTURE_SCREEN'] },
      'app-privilege-capabilities': ['AllowAppUsePrivilegeExtension'],
    });
    const signApp = call('sign-app');
    expect(arg(signApp, '-keyAlias')).toBe('OpenHarmony Application Release');
    expect(path.basename(arg(signApp, '-appCertFile')!)).toBe('OpenHarmonyApplication.cer');
    expect([arg(signApp, '-keyPwd'), arg(signApp, '-keystorePwd')]).toEqual(['k', 's']);
    expect(fs.readFileSync(hapPath).subarray(-6).toString()).toBe('SIGNED');
  });

  it('leaves no output behind when hap-sign-tool fails', async () => {
    exec.mockImplementation(((cmd: string, args: string[]) => {
      if (!args.includes('sign-app')) return fakeHapSignTool(cmd, args);
      fs.writeFileSync(arg(args, '-outFile')!, 'partial');
      throw new Error('exit 1');
    }) as never);
    await expect(signOpenHarmonyHap({ hapPath, sdkHome })).rejects.toThrow(/hap-sign-tool failed to sign/);
    expect(fs.readdirSync(tmp).sort()).toEqual(['entry-default-unsigned.hap', 'sdk']);
  });

  it('sends a HarmonyOS HAP to --harmonyos, and needs an installed SDK', async () => {
    writeHap({ bundleName: 'com.example.prebuilt', compileSdkType: 'HarmonyOS' });
    await expect(signOpenHarmonyHap({ hapPath, sdkHome })).rejects.toThrow(/sign --harmonyos --hap/);
    writeHap({ bundleName: 'com.example.prebuilt' });
    await expect(signOpenHarmonyHap({ hapPath, sdkHome: path.join(tmp, 'none') })).rejects.toThrow(/oniro-app sdk install/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('pickSigningSdk', () => {
  it('prefers the API level the HAP targets, else the newest SDK that has hap-sign-tool', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-picksdk-'));
    try {
      for (const api of ['9', '12', '20']) {
        fs.mkdirSync(path.join(home, api, 'toolchains', 'lib'), { recursive: true });
        if (api !== '20') fs.writeFileSync(path.join(home, api, 'toolchains', 'lib', 'hap-sign-tool.jar'), '');
      }
      fs.mkdirSync(path.join(home, 'notes'));
      expect(pickSigningSdk(home, 9)).toEqual({ api: '9', sdkPath: path.join(home, '9') });
      expect(pickSigningSdk(home, 20)).toEqual({ api: '12', sdkPath: path.join(home, '12') });
      expect(pickSigningSdk(home)).toEqual({ api: '12', sdkPath: path.join(home, '12') });
      expect(pickSigningSdk(path.join(home, 'absent'))).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
