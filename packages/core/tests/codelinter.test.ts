import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODELINTER_OHOS_SDK_ARG,
  cleanCodelinterOutput,
  codelinterInvocation,
  expandCodelinterFiles,
  missingProjectRootFiles,
  parseCodelinterReport,
} from '../src/build/codelinter.js';
import { staticConfig } from '../src/ports/config.js';
import { SdkNotInstalledError } from '../src/ports/errors.js';
import { getOsFolder } from '../src/sdk/platform.js';

// Shaped like real codelinter 6.0 output (ANSI colours, a `\r`-redrawn progress bar).
const ESC = '\u001b';
const DEFECTS =
  `${ESC}[32mThe configuration file C:\\proj\\code-linter.json5 in the project is in use.${ESC}[0m\n` +
  `${ESC}[32mWorking...[=>---]2%${ESC}[0m\r${ESC}[32mCurrently active product: default${ESC}[0m      \n` +
  `${ESC}[32mFinished...[=====]100%${ESC}[0m\n` +
  'CodeLinter found some defects in your code.\n' +
  'C:\\proj\\entry\\src\\main\\ets\\components\\Common.ets(2)\n' +
  '4:15        warn        Preferentially use the @Builder method instead of custom components.              @performance/avoid-overusing-custom-component-check\n' +
  '35:15       error       Unexpected any. Specify a different type.                                          @typescript-eslint/no-explicit-any\n' +
  'C:\\proj\\entry\\src\\main\\ets\\pages\\Index.ets(1)\n' +
  '108:16      suggestion  Avoid repeated creation of Date objects in loops or frequently called methods.    @performance/reuse-date-instances-check\n' +
  '-Defects: 3; Errors: 1; Warns: 1; Suggestions: 1;\n';

const MISMATCH =
  `${ESC}[31mThe type of command line tools does not match that of the project. Use the command line tools intended for OpenHarmony projects.${ESC}[0m\n` +
  `${ESC}[32mWorking...[==>--]5%${ESC}[0m\r${ESC}[31mSome error occurred during linting. This may cause incomplete report results.${ESC}[0m\n` +
  `${ESC}[32mFinished...[=====]100%${ESC}[0m\n` +
  `${ESC}[32mNo defects found in your code.${ESC}[0m\n`;

describe('parseCodelinterReport', () => {
  it('parses the per-file table and the totals', () => {
    const report = parseCodelinterReport(DEFECTS);
    expect(report.summary).toEqual({ defects: 3, errors: 1, warnings: 1, suggestions: 1 });
    expect(report.findings).toEqual([
      {
        file: 'C:\\proj\\entry\\src\\main\\ets\\components\\Common.ets',
        line: 4,
        column: 15,
        severity: 'warning',
        code: '@performance/avoid-overusing-custom-component-check',
        message: 'Preferentially use the @Builder method instead of custom components.',
      },
      {
        file: 'C:\\proj\\entry\\src\\main\\ets\\components\\Common.ets',
        line: 35,
        column: 15,
        severity: 'error',
        code: '@typescript-eslint/no-explicit-any',
        message: 'Unexpected any. Specify a different type.',
      },
      {
        file: 'C:\\proj\\entry\\src\\main\\ets\\pages\\Index.ets',
        line: 108,
        column: 16,
        severity: 'suggestion',
        code: '@performance/reuse-date-instances-check',
        message: 'Avoid repeated creation of Date objects in loops or frequently called methods.',
      },
    ]);
    expect(report.incomplete).toBe(false);
  });

  it('reports a clean run as zero totals, and the tools mismatch as incomplete', () => {
    const report = parseCodelinterReport(MISMATCH);
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ defects: 0, errors: 0, warnings: 0, suggestions: 0 });
    expect(report.incomplete).toBe(true);
    expect(report.notices).toEqual([
      'The type of command line tools does not match that of the project. Use the command line tools intended for OpenHarmony projects.',
      'Some error occurred during linting. This may cause incomplete report results.',
    ]);
  });

  it('reads a file argument codelinter dropped as an incomplete run', () => {
    const report = parseCodelinterReport('entry/src/main/ets/pages/*.ets not exists\nNo defects found in your code.\n');
    expect(report.incomplete).toBe(true);
    expect(report.notices).toEqual(['entry/src/main/ets/pages/*.ets not exists']);
  });

  it('has no summary when codelinter printed no report', () => {
    expect(parseCodelinterReport('codelinter: command crashed\n').summary).toBeNull();
  });
});

describe('cleanCodelinterOutput', () => {
  it('drops colour codes and keeps only the last redraw of a progress line', () => {
    expect(cleanCodelinterOutput(`${ESC}[32mWorking...[=>]2%${ESC}[0m\r${ESC}[32mFinished...[==]100%${ESC}[0m\n`)).toBe(
      'Finished...[==]100%\n',
    );
  });
});

describe('missingProjectRootFiles', () => {
  it('names the project-root files codelinter needs that a directory lacks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-lint-root-'));
    try {
      fs.writeFileSync(path.join(dir, 'build-profile.json5'), '{}');
      expect(missingProjectRootFiles(dir)).toEqual(['hvigorfile.ts', path.join('hvigor', 'hvigor-config.json5')]);
      fs.writeFileSync(path.join(dir, 'hvigorfile.js'), '');
      expect(missingProjectRootFiles(dir)).toEqual([path.join('hvigor', 'hvigor-config.json5')]);
      fs.mkdirSync(path.join(dir, 'hvigor'));
      fs.writeFileSync(path.join(dir, 'hvigor', 'hvigor-config.json5'), '{}');
      expect(missingProjectRootFiles(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('codelinterInvocation', () => {
  let tmp: string;
  let tools: string;
  let sdkHome: string;
  let project: string;
  const config = (values: Record<string, string> = {}) =>
    staticConfig({ cmdToolsPath: tools, sdkRootDir: path.join(tmp, 'sdkroot'), ...values });
  const writeProject = (product: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(project, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', ...product }] }, modules: [] }),
    );

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-lint-inv-'));
    tools = path.join(tmp, 'tools');
    sdkHome = path.join(tmp, 'sdkroot', getOsFolder());
    project = path.join(tmp, 'project');
    fs.mkdirSync(path.join(sdkHome, '23'), { recursive: true });
    fs.mkdirSync(project);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("runs codelinter's entry under the tools' Node.js, not the bin/ launcher", () => {
    writeProject({ compileSdkVersion: 23, runtimeOS: 'OpenHarmony' });
    const inv = codelinterInvocation(config(), project, ['entry/src/main/ets/pages/Index.ets']);
    expect(inv.command).toBe(
      process.platform === 'win32'
        ? path.join(tools, 'tool', 'node', 'node.exe')
        : path.join(tools, 'tool', 'node', 'bin', 'node'),
    );
    expect(inv.args).toEqual([
      path.join(tools, 'codelinter', 'index.js'),
      CODELINTER_OHOS_SDK_ARG,
      'entry/src/main/ets/pages/Index.ets',
    ]);
    expect(inv.runtimeOS).toBe('OpenHarmony');
  });

  it("names the installed OpenHarmony SDK for local.properties when the project's does not hold its API", () => {
    writeProject({ compileSdkVersion: 23 });
    expect(codelinterInvocation(config(), project).sdkDir).toBe(sdkHome);
    // An sdk.dir without API 23 does not do either.
    fs.mkdirSync(path.join(tmp, 'other', '20'), { recursive: true });
    fs.writeFileSync(path.join(project, 'local.properties'), `sdk.dir=${path.join(tmp, 'other')}\n`);
    expect(codelinterInvocation(config(), project).sdkDir).toBe(sdkHome);
  });

  it("leaves local.properties alone when its sdk.dir holds the project's API", () => {
    writeProject({ compileSdkVersion: 20 });
    fs.mkdirSync(path.join(tmp, 'other', '20'), { recursive: true });
    fs.writeFileSync(path.join(project, 'local.properties'), `sdk.dir=${path.join(tmp, 'other')}\n`);
    const inv = codelinterInvocation(config(), project);
    expect(inv.args[1]).toBe(CODELINTER_OHOS_SDK_ARG);
    expect(inv.sdkDir).toBeUndefined();
  });

  it('reads sdk.dir as codelinter does: relative to the project, only lines starting with it', () => {
    writeProject({ compileSdkVersion: 20 });
    fs.mkdirSync(path.join(tmp, 'other', '20'), { recursive: true });
    fs.writeFileSync(path.join(project, 'local.properties'), 'sdk.dir=../other\n');
    expect(codelinterInvocation(config(), project).sdkDir).toBeUndefined();
    // codelinter skips an indented line, so API 20 must come from the installed SDK.
    fs.writeFileSync(path.join(project, 'local.properties'), `  sdk.dir=${path.join(tmp, 'other')}\n`);
    expect(() => codelinterInvocation(config(), project)).toThrow(SdkNotInstalledError);
  });

  it("throws SdkNotInstalledError when the OpenHarmony project's SDK is not installed", () => {
    writeProject({ compileSdkVersion: 18 });
    expect(() => codelinterInvocation(config(), project)).toThrow(SdkNotInstalledError);
  });

  it("passes a HarmonyOS project the tools' own HarmonyOS SDK, as their launcher does", () => {
    writeProject({ compileSdkVersion: '6.1.1(24)', runtimeOS: 'HarmonyOS' });
    fs.mkdirSync(path.join(tools, 'sdk', 'default', 'hms'), { recursive: true });
    const inv = codelinterInvocation(config({ harmonyosSdkPath: path.join(tmp, 'elsewhere') }), project);
    expect(inv).toMatchObject({ runtimeOS: 'HarmonyOS', args: [path.join(tools, 'codelinter', 'index.js'), path.join(tools, 'sdk')] });
    expect(inv.sdkDir).toBeUndefined();
  });

  it('passes a HarmonyOS project the HarmonyOS SDK a build uses when the tools bundle none', () => {
    writeProject({ compileSdkVersion: '6.1.1(24)', runtimeOS: 'HarmonyOS' });
    const hos = path.join(tmp, 'hos');
    fs.mkdirSync(path.join(hos, 'default', 'openharmony'), { recursive: true });
    expect(codelinterInvocation(config({ harmonyosSdkPath: hos }), project).args[1]).toBe(hos);
    if (process.platform === 'linux') {
      // No DevEco Studio on Linux: no HarmonyOS SDK at all.
      expect(() => codelinterInvocation(config(), project)).toThrow(/No HarmonyOS SDK found/);
    }
  });
});

describe('expandCodelinterFiles', () => {
  it('expands glob patterns against the project and passes other arguments on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-lint-glob-'));
    try {
      fs.mkdirSync(path.join(dir, 'pages'));
      fs.writeFileSync(path.join(dir, 'pages', 'B.ets'), '');
      fs.writeFileSync(path.join(dir, 'pages', 'A.ets'), '');
      const hasGlob = typeof (fs as { globSync?: unknown }).globSync === 'function';
      expect(expandCodelinterFiles(dir, ['pages/*.ets', 'x.ets', 'none/*.ets'])).toEqual(
        hasGlob ? [path.join('pages', 'A.ets'), path.join('pages', 'B.ets'), 'x.ets', 'none/*.ets'] : ['pages/*.ets', 'x.ets', 'none/*.ets'],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
