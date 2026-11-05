import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTestOutput, statusFromCode } from '../src/testing/parseTestOutput.js';
import { aaTestCommand, decideOutcome, readTestModuleName, runTests, testHapPath } from '../src/testing/runTests.js';
import { discoverHaps, isTestHap } from '../src/build/discoverHaps.js';
import { isLockScreenShown, parsePowerState } from '../src/hdc/power.js';
import { staticConfig } from '../src/ports/config.js';

// Recorded with `aa test` on an OpenHarmony 7.0 device (Hypium 1.0.24, API 20 build).
const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'test-runner', `${name}.txt`), 'utf8');

describe('parseTestOutput', () => {
  it('reads a passing run', () => {
    const parsed = parseTestOutput(fixture('aa-test-pass'));
    expect(parsed.tests).toEqual([
      { suite: 'ActsAbilityTest', name: 'assertContain', status: 'pass', statusCode: 0, durationMs: 1 },
      { suite: 'IndexTest', name: 'startsEntryAbility', status: 'pass', statusCode: 0, durationMs: 1835 },
      { suite: 'IndexTest', name: 'tapShowsWelcome', status: 'pass', statusCode: 0, durationMs: 658 },
    ]);
    expect(parsed.summary).toEqual({ run: 3, pass: 3, fail: 0, error: 0, ignore: 0 });
    expect(parsed.summaryReported).toBe(true);
    expect(parsed.reportCode).toBe(0);
    expect(parsed.resultCode).toBe(0);
    expect(parsed.resultMessage).toBe('your test finished!!!');
    expect(parsed.durationMs).toBe(2494);
  });

  it('reads a failed assertion (-2) and a thrown error (-1) with their message and stack', () => {
    const parsed = parseTestOutput(fixture('aa-test-fail'));
    const [failed, threw] = parsed.tests;
    expect(failed).toMatchObject({
      suite: 'ActsAbilityTest',
      name: 'listHasItems',
      status: 'fail',
      statusCode: -2,
      message: 'expect 0 equals 3',
      durationMs: 2,
    });
    expect(failed!.stack).toMatch(/^at AssertException @ohos\/hypium/);
    expect(failed!.stack).toContain('at anonymous entry (entry/src/ohosTest/ets/test/Ability.test.ets:26:17)');
    expect(threw).toMatchObject({ name: 'throwsError', status: 'error', statusCode: -1, message: 'boom from test' });
    expect(threw!.stack).toMatch(/^at anonymous entry \(entry\/src\/ohosTest\/ets\/test\/Ability\.test\.ets:29:13\)/);
    expect(parsed.summary).toEqual({ run: 5, pass: 3, fail: 1, error: 1, ignore: 0 });
    // The run completed, though cases failed.
    expect(parsed.resultCode).toBe(0);
    expect(parsed.reportCode).toBe(-1);
  });

  it('reads a filtered run', () => {
    const parsed = parseTestOutput(fixture('aa-test-class'));
    expect(parsed.tests.map((t) => [t.name, t.status, t.message])).toEqual([
      ['tapShowsWelcome', 'error', 'Cannot read property getText of null'],
    ]);
  });

  it('reads the case list of a dry run', () => {
    const parsed = parseTestOutput(fixture('aa-test-dryrun'));
    expect(parsed.tests).toEqual([]);
    expect(parsed.dryRun).toEqual([
      { suite: 'ActsAbilityTest', name: 'listHasItems' },
      { suite: 'ActsAbilityTest', name: 'throwsError' },
      { suite: 'ActsAbilityTest', name: 'assertContain' },
      { suite: 'IndexTest', name: 'startsEntryAbility' },
      { suite: 'IndexTest', name: 'tapShowsWelcome' },
    ]);
  });

  it('reads a run that could not start', () => {
    const parsed = parseTestOutput(fixture('aa-test-nomodule'));
    expect(parsed).toMatchObject({
      tests: [],
      summaryReported: false,
      resultCode: -1,
      resultMessage: 'The specified module name is not found.',
    });
  });

  it('counts the cases when the runner died before its summary', () => {
    const cut = fixture('aa-test-fail').split('OHOS_REPORT_RESULT')[0]!;
    const parsed = parseTestOutput(cut);
    expect(parsed.summaryReported).toBe(false);
    expect(parsed.summary).toEqual({ run: 5, pass: 3, fail: 1, error: 1, ignore: 0 });
    expect(parsed.resultCode).toBeUndefined();
  });

  it('maps status codes', () => {
    expect([0, -1, -2, -3, 7].map(statusFromCode)).toEqual(['pass', 'error', 'fail', 'ignore', 'unknown']);
  });
});

describe('decideOutcome', () => {
  const summary = (fail = 0, error = 0, run = 3) => ({ run, pass: run - fail - error, fail, error, ignore: 0 });
  it('passes, fails, or blames the runner', () => {
    expect(decideOutcome({ resultCode: 0, summary: summary(), completed: true })).toEqual({ outcome: 'passed' });
    expect(decideOutcome({ resultCode: 0, summary: summary(1), completed: true })).toEqual({ outcome: 'failed' });
    expect(decideOutcome({ resultCode: 0, summary: summary(0, 1), completed: true })).toEqual({ outcome: 'failed' });
    expect(decideOutcome({ resultCode: -1, summary: summary(0, 0, 0), completed: true }).outcome).toBe('runner-error');
    expect(decideOutcome({ resultCode: 0, summary: summary(0, 0, 0), completed: true })).toEqual({
      outcome: 'runner-error',
      error: 'No test case ran.',
    });
    expect(decideOutcome({ summary: summary(), completed: false }).outcome).toBe('runner-error');
  });
});

describe('aaTestCommand', () => {
  it('builds the runner command, quoting what comes from the project', () => {
    expect(aaTestCommand({ bundle: 'com.example.app', testModule: 'entry_test' })).toBe(
      "aa test -b 'com.example.app' -m 'entry_test' -s unittest OpenHarmonyTestRunner -s timeout 15000",
    );
    expect(
      aaTestCommand({ bundle: 'b', testModule: 'm', caseTimeoutMs: 5000, testClass: 'IndexTest#tapShowsWelcome,Other' }),
    ).toBe("aa test -b 'b' -m 'm' -s unittest OpenHarmonyTestRunner -s class 'IndexTest#tapShowsWelcome,Other' -s timeout 5000");
  });
});

describe('test HAPs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-testhap-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('are recognised by name and left out of the HAPs to install', async () => {
    expect(isTestHap('entry-ohosTest-signed.hap')).toBe(true);
    expect(isTestHap('entry-ohosTest-unsigned.hap')).toBe(true);
    expect(isTestHap('entry-default-signed.hap')).toBe(false);
    const main = path.join(dir, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-signed.hap');
    const test = testHapPath(path.join(dir, 'entry'), 'entry');
    expect(test).toBe(path.join(dir, 'entry', 'build', 'default', 'outputs', 'ohosTest', 'entry-ohosTest-signed.hap'));
    for (const f of [main, test]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '');
    }
    // The test HAP is newer, and would otherwise be picked for install.
    fs.utimesSync(main, new Date(1000), new Date(1000));
    expect(await discoverHaps({ projectDir: dir })).toEqual({ entry: { signed: [main], unsigned: [] } });
  });

  it('come from a module whose ohosTest source set names the test module', () => {
    fs.mkdirSync(path.join(dir, 'src', 'ohosTest'), { recursive: true });
    expect(() => readTestModuleName(path.join(dir, 'missing'))).toThrow(/No test module/);
    fs.writeFileSync(path.join(dir, 'src', 'ohosTest', 'module.json5'), '{ module: { name: "entry_test" } }');
    expect(readTestModuleName(dir)).toBe('entry_test');
  });
});

describe('screen state', () => {
  it('reads the power state and the lock screen', () => {
    expect(parsePowerState('POWER STATE DUMP:\nCurrent State: SLEEP  Reason: 1  Time: 1\n')).toBe('SLEEP');
    expect(parsePowerState('nothing')).toBeNull();
    expect(isLockScreenShown({ children: [{ id: 'ScreenLockRootComponent' }] })).toBe(true);
    expect(isLockScreenShown({ children: [{ id: 'SCBDesktop_Flex_Desktop' }] })).toBe(false);
  });
});

// hdc is a shell-script stand-in that answers each command the run sends.
describe.skipIf(process.platform === 'win32')('runTests against a stand-in hdc', () => {
  let tmp: string;
  let projectDir: string;
  let log: string;

  const project = () => {
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(projectDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(projectDir, rel), content);
    };
    write('build-profile.json5', JSON.stringify({ app: { products: [{ name: 'default' }] }, modules: [{ name: 'entry', srcPath: './entry' }] }));
    write('AppScope/app.json5', JSON.stringify({ app: { bundleName: 'com.example.probe' } }));
    write('entry/src/ohosTest/module.json5', JSON.stringify({ module: { name: 'entry_test' } }));
    write('entry/build/default/outputs/default/entry-default-signed.hap', '');
    write('entry/build/default/outputs/ohosTest/entry-ohosTest-signed.hap', '');
  };

  const fakeHdc = (aaTestFixture: string) => {
    const hdc = path.join(tmp, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "install"*) echo "[Info]App install path:x msg:install bundle successfully."; echo "AppMod finish" ;;
  *"bm dump -n"*) echo "com.example.probe:"; echo "{}" ;;
  *"pidof"*) echo 4242 ;;
  *"hidumper -s 3301"*) echo "Current State: AWAKE  Reason: 34" ;;
  *"uitest dumpLayout"*) echo "no device layout" ; exit 1 ;;
  *"power-shell"*) echo ok ;;
  "shell hilog")
    echo "11-05 11:44:41.850  4242  4242 E A00000/testTag: from the app"
    echo "11-05 11:44:41.851  999  999 I C01406/OHOS::RS: another process" ;;
  *"aa test"*) cat "${path.join(__dirname, 'fixtures', 'test-runner')}/${aaTestFixture}.txt" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    return staticConfig({ hdcPath: hdc });
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-runtests-'));
    projectDir = path.join(tmp, 'project');
    log = path.join(tmp, 'hdc.log');
    project();
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('installs both HAPs, runs the suite and reports a failed case', async () => {
    const report = await runTests({ config: fakeHdc('aa-test-fail'), projectDir, build: false });
    expect(report).toMatchObject({
      ok: false,
      outcome: 'failed',
      bundle: 'com.example.probe',
      testModule: 'entry_test',
      summary: { run: 5, pass: 3, fail: 1, error: 1, ignore: 0 },
      resultCode: 0,
      haps: {
        main: path.join(projectDir, 'entry/build/default/outputs/default/entry-default-signed.hap'),
        test: path.join(projectDir, 'entry/build/default/outputs/ohosTest/entry-ohosTest-signed.hap'),
      },
      warnings: [],
    });
    expect(report.error).toBeUndefined();
    const calls = fs.readFileSync(log, 'utf8').split('\n');
    const mainInstall = calls.findIndex((c) => c.startsWith('install -r') && c.includes('entry-default-signed.hap'));
    const testInstall = calls.findIndex((c) => c.startsWith('install -r') && c.includes('entry-ohosTest-signed.hap'));
    const run = calls.findIndex((c) => c.includes('aa test'));
    expect(mainInstall).toBeGreaterThanOrEqual(0);
    expect(testInstall).toBeGreaterThan(mainInstall);
    expect(run).toBeGreaterThan(testInstall);
    expect(calls[run]).toBe(
      "shell aa test -b 'com.example.probe' -m 'entry_test' -s unittest OpenHarmonyTestRunner -s timeout 15000",
    );
    // The screen is held on for the run and restored after it.
    expect(calls).toContain('shell power-shell timeout -r');
  });

  it("keeps the app's hilog lines", async () => {
    const report = await runTests({ config: fakeHdc('aa-test-pass'), projectDir, build: false });
    expect(report.outcome).toBe('passed');
    expect(report.ok).toBe(true);
    // The stand-in's hilog exits at once, so whether the pid poll saw 4242 first
    // is a race; when a line is kept, it is the app's.
    for (const line of report.log) expect(line).toContain('4242');
  });

  it('reports a run that could not start as a runner error', async () => {
    const report = await runTests({ config: fakeHdc('aa-test-nomodule'), projectDir, build: false });
    expect(report).toMatchObject({
      ok: false,
      outcome: 'runner-error',
      resultCode: -1,
      error: 'The runner reported -1: The specified module name is not found.',
    });
  });

  it('reports missing HAPs without touching the device', async () => {
    fs.rmSync(path.join(projectDir, 'entry/build/default/outputs/ohosTest'), { recursive: true });
    const report = await runTests({ config: fakeHdc('aa-test-pass'), projectDir, build: false });
    expect(report).toMatchObject({ outcome: 'runner-error', error: expect.stringMatching(/^No test HAP at /) });
    expect(fs.existsSync(log)).toBe(false);
  });

  it('refuses a module the project does not declare', async () => {
    await expect(runTests({ config: fakeHdc('aa-test-pass'), projectDir, module: 'feature', build: false })).rejects.toThrow(
      /Module feature is not declared/,
    );
  });
});
