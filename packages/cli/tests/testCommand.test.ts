import { describe, expect, it } from 'vitest';
import { formatTestCase, projectFrame, testExitCode } from '../src/commands/test.js';
import { formatDiagnostics } from '../src/commands/build.js';

describe('test command output', () => {
  const stack =
    'at AssertException @ohos/hypium (oh_modules/.ohpm/@ohos+hypium@1.0.24/oh_modules/@ohos/hypium/src/main/service.js:72:9)\n' +
    '    at anonymous entry (entry/src/ohosTest/ets/test/Ability.test.ets:26:17)';

  it('exits 0, 1 or 2 by outcome', () => {
    expect(testExitCode({ outcome: 'passed' })).toBe(0);
    expect(testExitCode({ outcome: 'failed' })).toBe(1);
    expect(testExitCode({ outcome: 'runner-error' })).toBe(2);
  });

  it("points at the first frame in the project's own code", () => {
    expect(projectFrame(stack)).toBe('entry/src/ohosTest/ets/test/Ability.test.ets:26:17');
    expect(projectFrame(undefined)).toBeUndefined();
  });

  it('prints one line per case, with the message and location of a failure', () => {
    expect(formatTestCase({ suite: 'S', name: 'ok', status: 'pass', statusCode: 0, durationMs: 3 })).toBe('PASS S > ok (3 ms)');
    expect(
      formatTestCase({ suite: 'S', name: 'bad', status: 'fail', statusCode: -2, message: 'expect 0 equals 3', stack }),
    ).toBe('FAIL S > bad\n    expect 0 equals 3\n    at entry/src/ohosTest/ets/test/Ability.test.ets:26:17');
    expect(formatTestCase({ suite: 'S', name: 'odd', status: 'unknown', statusCode: 9 })).toBe('CODE 9 S > odd');
  });
});

describe('formatDiagnostics', () => {
  it('lists errors first, one per line, and caps the list', () => {
    const out = formatDiagnostics(
      [
        { severity: 'warning', source: 'arkts', message: 'deprecated', file: 'a.ets', line: 1, column: 2 },
        { severity: 'error', source: 'arkts', code: '10605008', rule: 'arkts-no-any-unknown', message: 'no any', file: 'b.ets', line: 5, column: 8 },
        { severity: 'error', source: 'ohpm', code: '00617101', message: 'not found' },
      ],
      2,
    );
    expect(out.split('\n')).toEqual([
      '  b.ets:5:8 error arkts 10605008: no any (arkts-no-any-unknown)',
      '  error ohpm 00617101: not found',
      '  … and 1 more',
    ]);
  });
});
