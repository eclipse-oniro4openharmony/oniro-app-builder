import { describe, expect, it } from 'vitest';
import { arktsCheckExitCode, arktsCheckSummaryLine } from '../src/commands/check.js';

describe('check arkts output', () => {
  it('exits 0 when clean, 1 on an error, 2 when nothing was checked', () => {
    expect(arktsCheckExitCode({ completed: true, ok: true })).toBe(0);
    expect(arktsCheckExitCode({ completed: true, ok: false })).toBe(1);
    expect(arktsCheckExitCode({ completed: false, ok: false })).toBe(2);
  });

  it('closes with the counts and the time taken', () => {
    const summary = { errors: 2, warnings: 1, fixed: 0, files: 4, checkerDiagnostics: 2 };
    expect(arktsCheckSummaryLine({ summary, durationMs: 3456 })).toBe('2 errors, 1 warnings in 4 files (3.5 s).');
    expect(arktsCheckSummaryLine({ summary: { ...summary, fixed: 1 }, durationMs: 100 })).toBe(
      '2 errors, 1 warnings, 1 fixed in 4 files (0.1 s).',
    );
  });
});
