import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  apiLevelOf,
  checkCmdTools,
  checkHdcSpeed,
  checkDisk,
  checkNode,
  checkSigning,
  CMD_TOOLS_REQUIRED,
  describeProject,
  runDoctor,
  SLOW_HDC_CALL_MS,
  type DoctorVersions,
} from '../src/doctor/doctor.js';
import { staticConfig } from '../src/ports/config.js';
import { getOsFolder } from '../src/sdk/platform.js';

const isWin = process.platform === 'win32';

describe('doctor checks', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-doctor-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A command-line tools install holding every required path, of the given flavour. */
  const makeTools = (flavour: 'OpenHarmony' | 'HarmonyOS' = 'OpenHarmony'): string => {
    const dir = path.join(tmp, 'tools');
    for (const rel of CMD_TOOLS_REQUIRED) {
      const full = path.join(dir, rel);
      if (rel.startsWith('bin/') || rel === 'version.txt') {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, rel === 'version.txt' ? '# Version: 6.1.1.280\n' : '');
      } else {
        fs.mkdirSync(full, { recursive: true });
      }
    }
    if (flavour === 'HarmonyOS') fs.mkdirSync(path.join(dir, 'sdk', 'default', 'hms'), { recursive: true });
    return dir;
  };

  const writeProject = (product: Record<string, unknown>, signingConfigs?: unknown[]): string => {
    const dir = path.join(tmp, 'Proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', signingConfig: 'default', ...product }], ...(signingConfigs ? { signingConfigs } : {}) } }),
    );
    return dir;
  };

  it('reads the API level from either compileSdkVersion form', () => {
    expect(apiLevelOf(20)).toBe(20);
    expect(apiLevelOf('18')).toBe(18);
    expect(apiLevelOf('6.0.0(20)')).toBe(20);
    expect(apiLevelOf('26.0.0')).toBe(26);
    expect(apiLevelOf('next')).toBeUndefined();
    expect(apiLevelOf(undefined)).toBeUndefined();
  });

  it('takes the minimum device API from compatibleSdkVersion', () => {
    const dir = writeProject({ compileSdkVersion: 20, compatibleSdkVersion: 18 });
    expect(describeProject(dir)).toMatchObject({ runtimeOS: 'OpenHarmony', compileSdkVersion: 20, minApi: 18 });
  });

  it('wants node 20 or newer', () => {
    expect(checkNode('20.11.0').status).toBe('ok');
    expect(checkNode('18.19.0')).toMatchObject({ status: 'fail', fix: expect.stringContaining('20') });
  });

  it('records the tools version and flavour of a complete install', () => {
    const versions: DoctorVersions = { node: '20' };
    const check = checkCmdTools(staticConfig({ cmdToolsPath: makeTools('HarmonyOS') }), versions);
    expect(check.status).toBe('ok');
    expect(versions).toMatchObject({ cmdTools: '6.1.1.280', cmdToolsFlavour: 'HarmonyOS' });
  });

  it('fails the tools when their hvigor is too old for an API 26 OpenHarmony project', () => {
    const tools = makeTools();
    fs.writeFileSync(path.join(tools, 'version.txt'), '# Version: 6.1.1.280\nhvigor : 6.24.2\n');
    const config = staticConfig({ cmdToolsPath: tools });
    const project = describeProject(writeProject({ compileSdkVersion: '26.0.0' }));
    const check = checkCmdTools(config, { node: '20' }, project);
    expect(check).toMatchObject({ status: 'fail', fix: expect.stringContaining('cmdtools install --from-zip') });
    expect(check.detail).toMatch(/API 26 needs hvigor 6\.26\.0 or later.*hvigor 6\.24\.2/);
    fs.writeFileSync(path.join(tools, 'version.txt'), '# Version: 26.0.0.821\nhvigor : 6.26.4\n');
    expect(checkCmdTools(config, { node: '20' }, project).status).toBe('ok');
    // An API 23 project builds with the older hvigor.
    fs.writeFileSync(path.join(tools, 'version.txt'), '# Version: 6.1.1.280\nhvigor : 6.24.2\n');
    expect(checkCmdTools(config, { node: '20' }, describeProject(writeProject({ compileSdkVersion: 23 }))).status).toBe('ok');
  });

  it('fails a partial install, naming what is missing (#16)', () => {
    const dir = makeTools();
    fs.rmSync(path.join(dir, 'codelinter'), { recursive: true });
    fs.rmSync(path.join(dir, 'tool'), { recursive: true });
    const check = checkCmdTools(staticConfig({ cmdToolsPath: dir }), { node: '20' });
    expect(check).toMatchObject({ status: 'fail', fix: 'oniro-app cmdtools install --force' });
    expect(check.detail).toMatch(/partial install: missing codelinter, tool\/node$/);
  });

  it('fails a directory with content but no ohpm as partial, and an absent one as not installed', () => {
    const dir = path.join(tmp, 'half');
    fs.mkdirSync(path.join(dir, 'hvigor'), { recursive: true });
    expect(checkCmdTools(staticConfig({ cmdToolsPath: dir }), { node: '20' }).detail).toMatch(/partial install: bin\/ohpm is missing/);
    expect(checkCmdTools(staticConfig({ cmdToolsPath: path.join(tmp, 'none') }), { node: '20' })).toMatchObject({
      status: 'fail',
      fix: 'oniro-app cmdtools install',
    });
  });

  it('checks the signing material the signingConfig names', () => {
    const material = { storeFile: './sig/a.p12', certpath: './sig/a.cer', profile: './sig/a.p7b' };
    const unsigned = describeProject(writeProject({ compileSdkVersion: 20 }));
    expect(checkSigning(unsigned)).toMatchObject({ status: 'warn', fix: 'oniro-app sign' });

    const dir = writeProject({ compileSdkVersion: 20 }, [{ name: 'default', material }]);
    expect(checkSigning(describeProject(dir))).toMatchObject({ status: 'fail', detail: expect.stringContaining('a.p7b') });
    fs.mkdirSync(path.join(dir, 'sig'));
    for (const f of ['a.p12', 'a.cer', 'a.p7b']) fs.writeFileSync(path.join(dir, 'sig', f), '');
    expect(checkSigning(describeProject(dir)).status).toBe('ok');
  });

  it('grades free disk space', () => {
    const stat = (gb: number) => () => ({ bavail: gb * 1024, bsize: 1024 ** 2 });
    expect(checkDisk([tmp], stat(0.5)).status).toBe('fail');
    expect(checkDisk([tmp], stat(3)).status).toBe('warn');
    expect(checkDisk([tmp], stat(50))).toMatchObject({ status: 'ok', detail: `50.0 GB free at ${tmp}` });
    // A directory that does not exist yet is measured at its nearest existing parent.
    expect(checkDisk([path.join(tmp, 'not', 'yet')], stat(50)).detail).toContain(tmp);
  });

  it('grades what one hdc call costs, and tells a slow client from a slow way to the device', () => {
    expect(checkHdcSpeed({ clientMs: 150, deviceMs: 190, serial: 'PHONE' })).toEqual({ id: 'hdc-speed', status: 'ok', detail: 'one call to PHONE takes 190 ms' });
    expect(checkHdcSpeed({ clientMs: 20 })).toEqual({ id: 'hdc-speed', status: 'ok', detail: 'one hdc call takes 20 ms' });
    expect(checkHdcSpeed({ clientMs: SLOW_HDC_CALL_MS, deviceMs: SLOW_HDC_CALL_MS })).toMatchObject({ status: 'ok' });
    // A client that starts a server and sleeps before it connects is slow without a device too (1.3 s on every call).
    const client = checkHdcSpeed({ clientMs: 1480, deviceMs: 1530, serial: 'PHONE' });
    expect(client).toMatchObject({ status: 'warn', detail: expect.stringContaining('every hdc call takes 1480 ms before it reaches a device') });
    expect(client.fix).toMatch(/`-p`/);
    // The client is quick and the device is far.
    const link = checkHdcSpeed({ clientMs: 40, deviceMs: 900, serial: 'PHONE' });
    expect(link).toMatchObject({ status: 'warn', detail: 'one call to PHONE takes 900 ms (hdc alone answers in 40 ms)' });
    expect(link.fix).toMatch(/way to the device/);
  });

  it.skipIf(isWin)('times a call to the connected device, and warns when the client sleeps', async () => {
    const stand = (sleep: string): string => {
      const hdc = path.join(tmp, `hdc${sleep.replace('.', '')}`);
      fs.writeFileSync(
        hdc,
        `#!/bin/sh\n[ "$1" = "-t" ] && shift 2\ncase "$1" in\n  version) echo "Ver: 3.2.0d" ;;\n  list) sleep ${sleep}; printf 'FAKE\\tUSB\\tConnected\\tlocalhost\\n' ;;\n  shell) [ "$2" = "echo" ] && [ -f "$0.offline" ] && { echo "[Fail]ExecuteCommand need connect-key?"; exit 0; } ;;\nesac\nexit 0\n`,
        { mode: 0o755 },
      );
      return hdc;
    };
    const speed = async (hdc: string) => {
      const report = await runDoctor({ config: staticConfig({ sdkRootDir: path.join(tmp, 'sdk'), cmdToolsPath: path.join(tmp, 'none'), hdcPath: hdc }), env: { PATH: '' }, arktsSelfTest: false });
      return report.checks.find((c) => c.id === 'hdc-speed')!;
    };
    expect(await speed(stand('0'))).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^one call to FAKE takes \d+ ms$/) });
    const slow = await speed(stand('0.8'));
    expect(slow).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^every hdc call takes \d+ ms before it reaches a device/) });
    // A device that refuses the call answers at once: that is not a quick call, and no time is reported.
    const offline = stand('0');
    fs.writeFileSync(`${offline}.offline`, '');
    expect(await speed(offline)).toMatchObject({ status: 'skip', detail: expect.stringMatching(/^not measured: a call to FAKE failed/) });
  }, 60_000);

  it.skipIf(isWin)('installs a missing SDK with --fix, and self-tests check arkts', async () => {
    const sdkRoot = path.join(tmp, 'sdk');
    const project = writeProject({ compileSdkVersion: 20, compatibleSdkVersion: 20 });
    const hdc = path.join(tmp, 'hdc');
    fs.writeFileSync(hdc, '#!/bin/sh\necho "Ver: 3.2.0d"\n', { mode: 0o755 });
    const installs: string[] = [];
    // A stand-in checker that reports the planted error on line 11 of the generated file.
    const checker = path.join(tmp, 'checker.cjs');
    fs.writeFileSync(
      checker,
      `process.stdout.write(JSON.stringify({ success: false, errors: [{ file: 'entry/src/main/ets/pages/Index.ets', line: 11, column: 12, severity: 'error', message: 'Use explicit types instead of "any", "unknown"', rule: 'arkts-no-any-unknown' }], summary: { fileCount: 1, checkerDiagCount: 1 } }));\n`,
    );

    const report = await runDoctor({
      config: staticConfig({ sdkRootDir: sdkRoot, cmdToolsPath: makeTools(), hdcPath: hdc }),
      projectDir: project,
      fix: true,
      device: false,
      env: { PATH: '' },
      arktsCheckerScript: checker,
      installSdk: async (opts) => {
        installs.push(`${opts.version}/${opts.api}`);
        fs.mkdirSync(path.join(sdkRoot, getOsFolder(), opts.api, 'ets'), { recursive: true });
      },
    });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(installs).toEqual(['6.0/20']);
    expect(byId.sdk).toMatchObject({ status: 'ok', fixed: true });
    expect(byId['arkts-check']).toMatchObject({ status: 'ok', detail: expect.stringContaining('caught the planted error') });
    expect(byId.hdc).toMatchObject({ status: 'ok' });
    expect(byId.device!.status).toBe('skip');
    expect(byId['hdc-speed']).toMatchObject({ status: 'skip', detail: 'device check not requested' });
    expect(byId.java!.status).toBe('fail');
    expect(report.ok).toBe(false);
    expect(report.versions).toMatchObject({ hdc: 'Ver: 3.2.0d', cmdTools: '6.1.1.280', sdk: path.join(sdkRoot, getOsFolder(), '20') });
  });

  it('fails an API 26 SDK left in the legacy <api> folder, and moves it with --fix', async () => {
    const sdkRoot = path.join(tmp, 'sdk');
    const home = path.join(sdkRoot, getOsFolder());
    fs.mkdirSync(path.join(home, '26', 'ets'), { recursive: true });
    fs.writeFileSync(path.join(home, '26', 'ets', 'oh-uni-package.json'), JSON.stringify({ apiVersion: '26', platformVersion: '26.0.0' }));
    const project = writeProject({ compileSdkVersion: '26.0.0', compatibleSdkVersion: '26.0.0' });
    const run = (fix: boolean) =>
      runDoctor({
        config: staticConfig({ sdkRootDir: sdkRoot, cmdToolsPath: path.join(tmp, 'none'), hdcPath: path.join(tmp, 'none', 'hdc') }),
        projectDir: project,
        fix,
        device: false,
        arktsSelfTest: false,
        env: { PATH: '' },
        installSdk: async () => {
          throw new Error('nothing to install');
        },
      });

    let sdk = (await run(false)).checks.find((c) => c.id === 'sdk')!;
    expect(sdk).toMatchObject({ status: 'fail', fix: expect.stringContaining(path.join(home, '26.0.0')) });
    expect(sdk.detail).toBe(`API 26 is installed at ${path.join(home, '26')}, where hvigor 6.26 and later do not look for it`);
    expect(fs.readdirSync(home)).toEqual(['26']);

    const report = await run(true);
    sdk = report.checks.find((c) => c.id === 'sdk')!;
    expect(sdk).toMatchObject({ status: 'ok', fixed: true, detail: `API 26 at ${path.join(home, '26.0.0')}` });
    expect(report.versions.sdk).toBe(path.join(home, '26.0.0'));
    expect(fs.readdirSync(home)).toEqual(['26.0.0']);
  });

  it.skipIf(isWin)('fails the self-test when the checker runs but misses the planted error', async () => {
    const sdkRoot = path.join(tmp, 'sdk');
    fs.mkdirSync(path.join(sdkRoot, getOsFolder(), '18', 'ets', 'api'), { recursive: true });
    // A newer API folder without declarations is not one to check against.
    fs.mkdirSync(path.join(sdkRoot, getOsFolder(), '20', 'toolchains'), { recursive: true });
    const checker = path.join(tmp, 'checker.cjs');
    fs.writeFileSync(checker, `process.stdout.write(JSON.stringify({ success: true, errors: [], summary: { fileCount: 1 } }));\n`);
    const report = await runDoctor({
      config: staticConfig({ sdkRootDir: sdkRoot, cmdToolsPath: path.join(tmp, 'none'), hdcPath: path.join(tmp, 'none', 'hdc') }),
      device: true,
      env: { PATH: '' },
      arktsCheckerScript: checker,
    });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId['arkts-check']).toMatchObject({ status: 'fail', detail: expect.stringContaining('missed a planted') });
    // Without hdc there is no device check to run.
    expect(byId.device).toMatchObject({ status: 'fail', detail: 'hdc is not usable' });
    expect(byId['hdc-speed']).toMatchObject({ status: 'skip', detail: 'hdc is not usable' });
    expect(byId.sdk!.status).toBe('skip');
  });
});
