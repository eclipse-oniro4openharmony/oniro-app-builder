import { describe, expect, it } from 'vitest';
import { doctorExitCode, formatDoctorCheck } from '../src/commands/doctor.js';

describe('doctor output', () => {
  it('prints a check per line, with its fix under a failure', () => {
    expect(formatDoctorCheck({ id: 'node', status: 'ok', detail: 'node 20.11.0' })).toBe('ok    node             node 20.11.0');
    expect(
      formatDoctorCheck({ id: 'sdk', status: 'fail', detail: 'API 18 is not installed', fix: 'oniro-app sdk install 5.1.0' }),
    ).toBe(`fail  sdk              API 18 is not installed\n${' '.repeat(23)}fix: oniro-app sdk install 5.1.0`);
    expect(formatDoctorCheck({ id: 'sdk', status: 'ok', detail: 'API 18', fixed: true, fix: 'unused' })).toBe(
      'ok    sdk              API 18 (fixed)',
    );
  });

  it('exits 1 when a check failed', () => {
    expect(doctorExitCode({ ok: true })).toBe(0);
    expect(doctorExitCode({ ok: false })).toBe(1);
  });
});
