import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanCodelinterOutput, missingProjectRootFiles, parseCodelinterReport } from '../src/build/codelinter.js';

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
