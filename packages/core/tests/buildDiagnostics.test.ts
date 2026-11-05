import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildOutputTail,
  dependencyApiDiagnostic,
  missingSdkSymbols,
  ohModulesPackage,
  parseBuildOutput,
  sdkTooOldDiagnostic,
  type BuildDiagnostic,
} from '../src/build/diagnostics.js';
import { BuildFailedError, buildHap, buildWithDiagnostics, diagnoseBuildFailure } from '../src/build/buildHap.js';
import { staticConfig } from '../src/ports/config.js';
import { getOsFolder } from '../src/sdk/platform.js';

// Recorded from hvigorw 6.24.2 (command-line tools 6.1.1.280) on probe apps scaffolded
// with `oniro-app create`, local paths replaced by /work/<Probe> and /home/user.
const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'build', `${name}.txt`), 'utf8');

describe('parseBuildOutput', () => {
  it('reads ArkTS compiler errors once, though hvigor prints the block twice', () => {
    const parsed = parseBuildOutput(fixture('arkts-errors'), { projectDir: '/work/Probe' });
    expect(parsed.failedTask).toBe(':entry:default@CompileArkTS');
    expect(parsed.diagnostics).toEqual([
      {
        severity: 'error',
        source: 'arkts',
        code: '10605008',
        rule: 'arkts-no-any-unknown',
        message: 'Use explicit types instead of "any", "unknown"',
        file: 'entry/src/main/ets/pages/Index.ets',
        line: 5,
        column: 24,
        task: ':entry:default@CompileArkTS',
      },
      {
        severity: 'error',
        source: 'arkts',
        code: '10505001',
        message: "Property 'nonExistentMethod' does not exist on type 'Index'.",
        file: 'entry/src/main/ets/pages/Index.ets',
        line: 6,
        column: 10,
        task: ':entry:default@CompileArkTS',
      },
    ]);
    // hvigor counts 3 errors and the FAQ pointer as a warning for these two diagnostics.
    expect(parsed.reportedErrors).toBe(3);
    expect(parsed.reportedWarnings).toBe(1);
  });

  it('reads located ArkTS warnings from a successful build', () => {
    const parsed = parseBuildOutput(fixture('arkts-warn'), { projectDir: '/work/Probe' });
    expect(parsed.failedTask).toBeUndefined();
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', source: 'arkts', message: "'pushUrl' has been deprecated.", line: 19, column: 18 }),
      expect.objectContaining({ severity: 'warning', source: 'arkts', message: "'showToast' has been deprecated.", line: 20, column: 24 }),
    ]);
  });

  it('reads an hvigor configuration error with the file it names', () => {
    const parsed = parseBuildOutput(fixture('ohostest-phone'), { projectDir: '/work/Probe' });
    expect(parsed.failedTask).toBe(':entry:ohosTest@SyscapTransform');
    expect(parsed.diagnostics).toEqual([
      {
        severity: 'error',
        source: 'hvigor',
        code: '00303060',
        message:
          'Configuration Error: The intersection of the system capability sets configured for multiple devices is empty.',
        file: 'entry/src/ohosTest/module.json5',
        task: ':entry:ohosTest@SyscapTransform',
      },
    ]);
  });

  it("reads a clang error, without hvigor's unknown-error wrapper around it", () => {
    const parsed = parseBuildOutput(fixture('native-compile'), { projectDir: '/work/ProbeNative' });
    expect(parsed.failedTask).toBe(':entry:default@BuildNativeWithNinja');
    expect(parsed.diagnostics).toEqual([
      {
        severity: 'error',
        source: 'native',
        message: "use of undeclared identifier 'undeclaredVar'",
        file: 'entry/src/main/cpp/napi_init.cpp',
        line: 5,
        column: 19,
        task: ':entry:default@BuildNativeWithNinja',
      },
    ]);
  });

  it('reads an lld undefined symbol with the source line that references it', () => {
    const parsed = parseBuildOutput(fixture('native-link'), { projectDir: '/work/ProbeNative' });
    expect(parsed.diagnostics).toEqual([
      {
        severity: 'error',
        source: 'native',
        message: 'undefined symbol: missingSymbol',
        file: 'entry/src/main/cpp/napi_init.cpp',
        line: 6,
        task: ':entry:default@BuildNativeWithNinja',
      },
    ]);
  });

  it('reads one diagnostic per symbol from GNU ld', () => {
    const out = 'a.cpp:3: undefined reference to `foo\'\na.cpp:4: undefined reference to `bar\'\n';
    expect(parseBuildOutput(out).diagnostics.map((d) => d.message)).toEqual([
      'undefined symbol: foo',
      'undefined symbol: bar',
    ]);
  });

  it('reads an ohpm failure with its cause', () => {
    const parsed = parseBuildOutput(fixture('ohpm-missing'), { projectDir: '/work/ProbeOhpm' });
    expect(parsed.diagnostics).toEqual([
      {
        severity: 'error',
        source: 'ohpm',
        code: '00617101',
        message: expect.stringMatching(
          /^Fetch Pkg Info Failed: FetchPackageInfo: "@ohos\/does-not-exist-xyz" failed \(NOTFOUND package/,
        ),
      },
    ]);
  });

  it('reads both shapes of a symbol missing from a kit', () => {
    const parsed = parseBuildOutput(fixture('sdk-too-old'), { projectDir: '/work/Probe18' });
    expect(parsed.diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      ['10505001', 1, 10],
      ['10505001', 2, 10],
      ['10311006', 1, 10],
    ]);
    expect(missingSdkSymbols(parsed.diagnostics)).toEqual([
      { symbol: 'BorderRadiusMode', module: '@kit.ArkUI' },
      { symbol: 'AppServiceExtensionAbility', module: '@kit.AbilityKit' },
    ]);
  });

  it('keeps paths outside the project absolute', () => {
    const out = '/elsewhere/lib.cpp:1:2: error: boom\n';
    expect(parseBuildOutput(out, { projectDir: '/work/P' }).diagnostics[0]!.file).toBe('/elsewhere/lib.cpp');
  });

  it('finds nothing in a clean build', () => {
    expect(parseBuildOutput('> hvigor BUILD SUCCESSFUL in 1 s\n').diagnostics).toEqual([]);
  });
});

describe('buildOutputTail', () => {
  it('keeps the last lines, colour codes removed', () => {
    expect(buildOutputTail('a\n\x1b[31mb\x1b[39m\nc\n\n', 2)).toBe('b\nc');
  });
});

describe('sdkTooOldDiagnostic', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdkhome-'));
    const kit = (api: string, name: string, body: string) => {
      fs.mkdirSync(path.join(home, api, 'ets', 'kits'), { recursive: true });
      fs.writeFileSync(path.join(home, api, 'ets', 'kits', `${name}.d.ts`), body);
    };
    kit('18', '@kit.ArkUI', 'export { Button };');
    kit('20', '@kit.ArkUI', 'export { Button, BorderRadiusMode };');
    kit('20', '@kit.AbilityKit', 'export { UIAbility };');
    kit('23', '@kit.ArkUI', 'export { Button, BorderRadiusMode };');
    kit('23', '@kit.AbilityKit', 'export { UIAbility, AppServiceExtensionAbility };');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const diags = parseBuildOutput(fixture('sdk-too-old'), { projectDir: '/work/Probe18' }).diagnostics;

  it('names the lowest installed API that declares every missing symbol', () => {
    const d = sdkTooOldDiagnostic(diags, home, 18);
    expect(d).toMatchObject({ severity: 'error', source: 'sdk', api: '23' });
    expect(d!.message).toMatch(/BorderRadiusMode \(@kit\.ArkUI\), AppServiceExtensionAbility \(@kit\.AbilityKit\) are not in API 18/);
  });

  it('says nothing when no newer SDK declares them (a system API, say)', () => {
    expect(sdkTooOldDiagnostic(diags, home, 23)).toBeNull();
    expect(sdkTooOldDiagnostic([], home, 18)).toBeNull();
    expect(sdkTooOldDiagnostic(diags, path.join(home, 'absent'), 18)).toBeNull();
  });
});

describe('diagnoseBuildFailure', () => {
  it("does not read hvigor's catch-all 00308018 around a native build as a missing SDK", () => {
    expect(diagnoseBuildFailure(fixture('native-compile'))).toBeUndefined();
  });

  it('still points a missing SDK path at sdk list', () => {
    expect(diagnoseBuildFailure('ERROR: 00308018 x\nSDK path does not exist: /x')).toMatch(/oniro-app sdk list/);
  });

  it('does not suggest the full SDK when a newer installed SDK has the symbol', () => {
    expect(diagnoseBuildFailure(fixture('sdk-too-old'))).toMatch(/full OpenHarmony SDK/);
    expect(diagnoseBuildFailure(fixture('sdk-too-old'), true)).toBeUndefined();
  });
});

describe('dependencyApiDiagnostic (#22)', () => {
  const arkts = (message: string, file: string): BuildDiagnostic => ({ severity: 'error', source: 'arkts', message, file });

  it('hints at the API level for missing properties inside oh_modules, naming the package and the SDK', () => {
    // Recorded: a HAR calling KeyEvent.isCapsLockOn (@since 19) in an API 18 build.
    const { diagnostics } = parseBuildOutput(fixture('dependency-too-old'), { projectDir: '/work/App' });
    const hint = dependencyApiDiagnostic(diagnostics, 'OpenHarmony 5.1.0 (API 18) at /sdk/18', 'install a newer SDK.');
    expect(hint).toMatchObject({ severity: 'warning', source: 'sdk' });
    expect(hint!.message).toBe(
      '1 error in dependencies (@demo/caps) reports a property or name the SDK does not declare; the build used ' +
        'OpenHarmony 5.1.0 (API 18) at /sdk/18. A dependency may need a newer API level: install a newer SDK.',
    );
  });

  it('counts `Cannot find name` too, and lists each package once', () => {
    const hint = dependencyApiDiagnostic(
      [
        arkts("Property 'getGlobalWindowMode' does not exist on type 'typeof window'.", '/p/oh_modules/@ohos/flutter_ohos/src/a.ets'),
        arkts("Cannot find name 'PiPWindow'.", 'oh_modules/.ohpm/@ohos+flutter_ohos@1.0.0/oh_modules/@ohos/flutter_ohos/b.ets'),
        arkts("Cannot find name 'X'.", 'oh_modules/.ohpm/plain@2.0.0/c.ets'),
      ],
      undefined,
      'r',
    );
    expect(hint!.message).toMatch(/^3 errors in dependencies \(@ohos\/flutter_ohos, plain\) report a property or name the SDK does not declare\. /);
  });

  it('stays out of errors in the project itself and of other messages', () => {
    expect(
      dependencyApiDiagnostic(
        [
          arkts("Property 'nonExistentMethod' does not exist on type 'Index'.", 'entry/src/main/ets/pages/Index.ets'),
          arkts('Use explicit types instead of "any"', 'oh_modules/@x/y/a.ets'),
        ],
        undefined,
        'r',
      ),
    ).toBeNull();
  });

  it('reads the package from oh_modules paths', () => {
    expect(ohModulesPackage('oh_modules/.ohpm/@ohos+flutter_ohos@1.0.0+h/oh_modules/@ohos/flutter_ohos/x.ets')).toBe('@ohos/flutter_ohos');
    expect(ohModulesPackage('/a/oh_modules/lodash/index.ets')).toBe('lodash');
    expect(ohModulesPackage('oh_modules/.ohpm/@ohos+flutter_ohos@1.0.0/x.ets')).toBe('@ohos/flutter_ohos');
    expect(ohModulesPackage('entry/src/x.ets')).toBeUndefined();
  });
});

// hvigorw and ohpm are shell-script stand-ins that replay a recorded fixture.
describe.skipIf(process.platform === 'win32')('buildHap / buildWithDiagnostics on a failing build', () => {
  let tmp: string;
  let projectDir: string;
  let cmdTools: string;

  const tool = (name: string, fixtureName: string | null, code: number) => {
    const file = path.join(cmdTools, 'bin', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = fixtureName ? `cat "${path.join(__dirname, 'fixtures', 'build', `${fixtureName}.txt`)}" >&2\n` : '';
    fs.writeFileSync(file, `#!/bin/sh\n${body}exit ${code}\n`, { mode: 0o755 });
  };

  const project = (compileSdkVersion?: number) => {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', ...(compileSdkVersion ? { compileSdkVersion } : {}) }] } }),
    );
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-build-diag-'));
    projectDir = path.join(tmp, 'project');
    cmdTools = path.join(tmp, 'tools');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const config = () => staticConfig({ cmdToolsPath: cmdTools, sdkRootDir: path.join(tmp, 'sdk') });

  it('throws a BuildFailedError carrying the diagnostics', async () => {
    project();
    fs.mkdirSync(path.join(projectDir, 'oh_modules'));
    tool('hvigorw', 'arkts-errors', 255);
    const err = await buildHap({ config: config(), projectDir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildFailedError);
    const failed = err as BuildFailedError;
    expect(failed.message).toBe('hvigorw exited with code 255');
    expect(failed.exitCode).toBe(255);
    expect(failed.failedTask).toBe(':entry:default@CompileArkTS');
    // The fixture's paths are /work/Probe, outside this project, so they stay absolute.
    expect(failed.diagnostics.map((d) => d.code)).toEqual(['10605008', '10505001']);
    expect(failed.summary).toEqual({ errors: 2, warnings: 0, reportedErrors: 3, reportedWarnings: 1 });
    expect(failed.rawTail).toMatch(/BUILD FAILED/);
    expect(failed.rawTail).not.toMatch(/\x1b\[/);
  });

  it('returns ok:false instead of throwing', async () => {
    project();
    fs.mkdirSync(path.join(projectDir, 'oh_modules'));
    tool('hvigorw', 'ohostest-phone', 255);
    const report = await buildWithDiagnostics({ config: config(), projectDir });
    expect(report).toMatchObject({
      ok: false,
      exitCode: 255,
      failedTask: ':entry:ohosTest@SyscapTransform',
      discoveredHaps: {},
      summary: { errors: 1, warnings: 0 },
      error: 'hvigorw exited with code 255',
    });
    expect(report.diagnostics[0]).toMatchObject({ source: 'hvigor', code: '00303060' });
  });

  it('reports an ohpm failure as a failed build', async () => {
    project();
    tool('ohpm', 'ohpm-missing', 1);
    tool('hvigorw', null, 0);
    const report = await buildWithDiagnostics({ config: config(), projectDir });
    expect(report).toMatchObject({ ok: false, exitCode: 1, failedTask: 'ohpm install --all' });
    expect(report.diagnostics).toEqual([expect.objectContaining({ source: 'ohpm', code: '00617101' })]);
  });

  it('reports a missing SDK as an sdk diagnostic', async () => {
    project(20);
    tool('hvigorw', null, 0);
    const report = await buildWithDiagnostics({ config: config(), projectDir });
    expect(report).toMatchObject({
      ok: false,
      missingSdk: { api: '20', version: '6.0', expectedPath: path.join(tmp, 'sdk', getOsFolder(), '20') },
      diagnostics: [{ severity: 'error', source: 'sdk', api: '20' }],
    });
  });

  it('names a newer installed SDK when the project uses symbols its own lacks', async () => {
    project(18);
    fs.mkdirSync(path.join(projectDir, 'oh_modules'));
    const home = path.join(tmp, 'sdk', getOsFolder());
    for (const api of ['18', '20']) fs.mkdirSync(path.join(home, api, 'ets', 'kits'), { recursive: true });
    fs.writeFileSync(path.join(home, '20', 'ets', 'kits', '@kit.ArkUI.d.ts'), 'export { BorderRadiusMode };');
    fs.writeFileSync(path.join(home, '20', 'ets', 'kits', '@kit.AbilityKit.d.ts'), 'export { AppServiceExtensionAbility };');
    tool('hvigorw', 'sdk-too-old', 255);
    const report = await buildWithDiagnostics({ config: config(), projectDir });
    const sdk = report.diagnostics.filter((d) => d.source === 'sdk');
    expect(sdk).toEqual([expect.objectContaining({ api: '20' })]);
    expect(report.error).toMatch(/Raise compileSdkVersion/);
    expect(report.error).not.toMatch(/full OpenHarmony SDK/);
  });

  /** An installed OpenHarmony SDK API folder, as `sdk install` leaves it. */
  const openHarmonySdk = (api: string, version: string): string => {
    const dir = path.join(tmp, 'sdk', getOsFolder(), api);
    fs.mkdirSync(path.join(dir, 'ets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ets', 'oh-uni-package.json'), JSON.stringify({ apiVersion: api, version }));
    return dir;
  };

  it('names the SDK a failed build used, in the error and as `sdk` (#22)', async () => {
    project(18);
    fs.mkdirSync(path.join(projectDir, 'oh_modules'));
    const sdkDir = openHarmonySdk('18', '5.1.0.107');
    tool('hvigorw', 'arkts-errors', 255);
    const report = await buildWithDiagnostics({ config: config(), projectDir });
    expect(report.sdk).toEqual({
      runtimeOS: 'OpenHarmony',
      displayName: 'OpenHarmony 5.1.0',
      version: '5.1.0.107',
      api: '18',
      path: sdkDir,
    });
    expect(report.error).toBe(`hvigorw exited with code 255\nBuilt against OpenHarmony 5.1.0 (API 18) at ${sdkDir}.`);
    expect(report.diagnostics.some((d) => d.source === 'sdk')).toBe(false);
  });

  it('hints that a dependency may need a newer API level when its code names missing properties', async () => {
    project(18);
    fs.mkdirSync(path.join(projectDir, 'oh_modules'));
    const sdkDir = openHarmonySdk('18', '5.1.0.107');
    tool('hvigorw', 'dependency-too-old', 255);
    const report = await buildWithDiagnostics({ config: config(), projectDir });
    const hint = report.diagnostics.find((d) => d.source === 'sdk');
    expect(hint).toMatchObject({ severity: 'warning' });
    expect(hint!.message).toContain(`the build used OpenHarmony 5.1.0 (API 18) at ${sdkDir}`);
    expect(hint!.message).toContain('oniro-app sdk install');
    expect(report.error).toContain(hint!.message);
  });

  it('names the HarmonyOS SDK of a failed HarmonyOS build, and how to get a newer one', async () => {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', runtimeOS: 'HarmonyOS', compileSdkVersion: '5.1.0(18)' }] } }),
    );
    fs.mkdirSync(path.join(projectDir, 'oh_modules'));
    fs.mkdirSync(path.join(cmdTools, 'sdk', 'default', 'openharmony'), { recursive: true });
    fs.writeFileSync(
      path.join(cmdTools, 'sdk', 'default', 'sdk-pkg.json'),
      JSON.stringify({ data: { displayName: 'HarmonyOS 5.1.0', platformVersion: '5.1.0', apiVersion: '18' } }),
    );
    tool('hvigorw', 'dependency-too-old', 255);
    const report = await buildWithDiagnostics({ config: config(), projectDir });
    expect(report.sdk).toEqual({
      runtimeOS: 'HarmonyOS',
      displayName: 'HarmonyOS 5.1.0',
      version: '5.1.0(18)',
      api: '18',
      path: path.join(cmdTools, 'sdk'),
    });
    expect(report.error).toContain(`the build used HarmonyOS 5.1.0 (API 18) at ${path.join(cmdTools, 'sdk')}`);
    expect(report.error).toContain('oniro-app cmdtools install --from-zip <zip> --force');
  });

  it('returns the warnings of a build that passed', async () => {
    project();
    fs.mkdirSync(path.join(projectDir, 'oh_modules'));
    tool('hvigorw', 'arkts-warn', 0);
    const report = await buildWithDiagnostics({ config: config(), projectDir });
    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({ errors: 0, warnings: 2 });
    expect(report.rawTail).toBe('');
  });
});
