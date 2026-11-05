import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  arktsCheckerScript,
  checkArkts,
  parseArktsCheckOutput,
  resolveArktsCheckSdk,
} from '../src/check/arktsCheck.js';
import { staticConfig } from '../src/ports/config.js';
import { SdkNotInstalledError } from '../src/ports/errors.js';
import { getOsFolder } from '../src/sdk/platform.js';

// The shape the vendored arkts-check.cjs prints. These tests never run the
// checker itself (it needs a real SDK): a stand-in script prints canned output.
const checkerJson = {
  success: false,
  errors: [
    { file: 'entry/src/main/ets/pages/Index.ets', line: 5, column: 24, severity: 'error', message: "Use explicit types instead of \"any\", \"unknown\"", rule: 'arkts-no-any-unknown' },
    { file: 'entry/src/main/ets/pages/Index.ets', line: 9, column: 1, severity: 'warning', message: "'foo' is deprecated.", rule: '' },
    { file: 'entry/src/main/resources/base/profile/main_pages.json', line: 3, column: 1, severity: 'error', message: "Page 'pages/Gone.ets' does not exist.", rule: 'page-file-exists' },
  ],
  fixed: [{ file: 'entry/src/main/ets/pages/Index.ets', line: 2, column: 10, severity: 'error', message: "Module '\"../model/M\"' declares 'M' locally, but it is not exported.", rule: '' }],
  alsoModified: ['entry/src/main/ets/model/M.ets'],
  summary: { errorCount: 2, warnCount: 1, fixedCount: 1, checkerDiagCount: 2, fileCount: 4 },
};

describe('parseArktsCheckOutput', () => {
  it('maps the checker result onto build diagnostics', () => {
    const r = parseArktsCheckOutput(JSON.stringify(checkerJson), '', 1);
    expect(r.ok).toBe(false);
    expect(r.completed).toBe(true);
    expect(r.diagnostics[0]).toEqual({
      severity: 'error',
      source: 'arkts-check',
      rule: 'arkts-no-any-unknown',
      message: 'Use explicit types instead of "any", "unknown"',
      file: 'entry/src/main/ets/pages/Index.ets',
      line: 5,
      column: 24,
    });
    // An empty rule is left out rather than reported as ''.
    expect(r.diagnostics[1]).not.toHaveProperty('rule');
    expect(r.summary).toEqual({ errors: 2, warnings: 1, fixed: 1, files: 4, checkerDiagnostics: 2 });
    expect(r.fixed).toHaveLength(1);
    expect(r.alsoModified).toEqual(['entry/src/main/ets/model/M.ets']);
  });

  it('is ok with warnings only', () => {
    const json = { success: true, errors: [checkerJson.errors[1]], summary: { errorCount: 0, warnCount: 1, fileCount: 1 } };
    const r = parseArktsCheckOutput(JSON.stringify(json), '', 0);
    expect(r).toMatchObject({ ok: true, completed: true, summary: { errors: 0, warnings: 1 } });
  });

  it('does not read a crash as a clean result', () => {
    const r = parseArktsCheckOutput('', 'Error: arkts_check could not complete: ...\n    at runChecker', 1);
    expect(r).toMatchObject({ ok: false, completed: false, diagnostics: [] });
    expect(r.error).toMatch(/exited 1 without a result, so nothing was checked/);
    expect(r.error).toContain('arkts_check could not complete');
  });

  it("reports the checker's own refusal as incomplete", () => {
    const json = { success: false, error: 'Cannot find ets/build-tools/ets-loader/lib/ets_checker.js in the SDK at: /x', errors: [], summary: { errorCount: 0, warnCount: 0 } };
    const r = parseArktsCheckOutput(JSON.stringify(json), '', 1);
    expect(r).toMatchObject({ ok: false, completed: false, error: json.error });
  });
});

describe('arktsCheckerScript', () => {
  it('finds the vendored checker', () => {
    const script = arktsCheckerScript();
    expect(script.endsWith(path.join('vendor', 'deveco-cli', 'arkts-check.cjs'))).toBe(true);
    expect(fs.existsSync(script)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(script), 'LICENSE'))).toBe(true);
  });
});

describe('resolveArktsCheckSdk and checkArkts', () => {
  let tmp: string;
  let project: string;
  let sdkRoot: string;

  const writeProfile = (product: Record<string, unknown>): void => {
    fs.writeFileSync(
      path.join(project, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', ...product }] }, modules: [{ name: 'entry', srcPath: './entry' }] }),
    );
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-arkts-check-'));
    project = path.join(tmp, 'Proj');
    sdkRoot = path.join(tmp, 'sdk');
    fs.mkdirSync(path.join(project, 'entry', 'src', 'main', 'ets', 'pages'), { recursive: true });
    fs.mkdirSync(path.join(sdkRoot, getOsFolder(), '20', 'ets'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("uses the API directory an OpenHarmony project's compileSdkVersion names", () => {
    writeProfile({ compileSdkVersion: 20, compatibleSdkVersion: 20, runtimeOS: 'OpenHarmony' });
    expect(resolveArktsCheckSdk(staticConfig({ sdkRootDir: sdkRoot }), project)).toEqual({
      dir: path.join(sdkRoot, getOsFolder(), '20'),
      runtimeOS: 'OpenHarmony',
      api: 20,
    });
  });

  it('throws SdkNotInstalledError when that API is not installed', () => {
    writeProfile({ compileSdkVersion: 18, compatibleSdkVersion: 18 });
    expect(() => resolveArktsCheckSdk(staticConfig({ sdkRootDir: sdkRoot }), project)).toThrow(SdkNotInstalledError);
  });

  it('uses the HarmonyOS SDK, with its hms/ets API directory, for a HarmonyOS project', () => {
    writeProfile({ compileSdkVersion: '6.0.0(20)', compatibleSdkVersion: '6.0.0(20)', runtimeOS: 'HarmonyOS' });
    const hos = path.join(tmp, 'hos', 'sdk');
    fs.mkdirSync(path.join(hos, 'default', 'openharmony'), { recursive: true });
    fs.mkdirSync(path.join(hos, 'default', 'hms', 'ets'), { recursive: true });
    const sdk = resolveArktsCheckSdk(
      staticConfig({ harmonyosSdkPath: hos, cmdToolsPath: path.join(tmp, 'none') }),
      project,
    );
    expect(sdk).toEqual({
      dir: path.join(hos, 'default', 'openharmony'),
      runtimeOS: 'HarmonyOS',
      hmsEtsDir: path.join(hos, 'default', 'hms', 'ets'),
    });
  });

  /** A stand-in checker that records its argv and prints `stdout`, or crashes. */
  const standIn = (stdout: string | null): string => {
    const script = path.join(tmp, 'stand-in.cjs');
    fs.writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\n` +
        (stdout === null
          ? `throw new Error('arkts_check could not complete: the ArkTS checker failed');\n`
          : `process.stdout.write(${JSON.stringify(stdout)});\n`),
    );
    return script;
  };
  const argv = (): string[] => JSON.parse(fs.readFileSync(path.join(tmp, 'argv.json'), 'utf8'));

  it('runs the checker against the project SDK and reports its findings', async () => {
    writeProfile({ compileSdkVersion: 20, compatibleSdkVersion: 20 });
    const report = await checkArkts({
      config: staticConfig({ sdkRootDir: sdkRoot }),
      projectDir: project,
      files: ['entry/src/main/ets/pages/Index.ets'],
      fix: true,
      scriptPath: standIn(JSON.stringify(checkerJson)),
    });
    expect(argv()).toEqual([
      '--project', project,
      '--sdk', path.join(sdkRoot, getOsFolder(), '20'),
      '--fix',
      '--files', path.join(project, 'entry/src/main/ets/pages/Index.ets'),
    ]);
    expect(report).toMatchObject({ ok: false, completed: true, summary: { errors: 2, warnings: 1, fixed: 1 } });
    expect(report.sdk).toMatchObject({ api: 20, runtimeOS: 'OpenHarmony' });
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a checker crash as an incomplete run, not a clean one', async () => {
    writeProfile({ compileSdkVersion: 20 });
    const report = await checkArkts({
      config: staticConfig({ sdkRootDir: sdkRoot }),
      projectDir: project,
      scriptPath: standIn(null),
    });
    expect(argv()).not.toContain('--fix');
    expect(argv()).not.toContain('--files');
    expect(report).toMatchObject({ ok: false, completed: false });
    expect(report.error).toContain('arkts_check could not complete');
  });

  it('takes an explicit SDK directory without reading compileSdkVersion', async () => {
    writeProfile({});
    const sdkDir = path.join(tmp, 'elsewhere');
    await checkArkts({ config: staticConfig({ sdkRootDir: sdkRoot }), projectDir: project, sdkDir, scriptPath: standIn('{}') });
    expect(argv().slice(2, 4)).toEqual(['--sdk', sdkDir]);
  });

  it('refuses a directory that is not a project', async () => {
    await expect(checkArkts({ config: staticConfig({}), projectDir: tmp })).rejects.toThrow(/no build-profile\.json5/);
  });
});
