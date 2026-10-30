import { describe, expect, it, afterEach } from 'vitest';
import { lintExitCode, lintFailed, lintTotals } from '../src/commands/lint.js';
import { formatLongDevice } from '../src/commands/devices.js';
import { hdcPassthroughArgv } from '../src/commands/hdc.js';

const warning = { file: 'a.ets', line: 1, column: 1, severity: 'warning', code: '', message: 'w' };
const error = { ...warning, severity: 'error', message: 'e' };

describe('lintExitCode', () => {
  it('exits 0 for warnings, although codelinter itself exits 1 for them', () => {
    expect(lintExitCode({ code: 1, findings: [warning], summary: { defects: 1, errors: 0, warnings: 1, suggestions: 0 } })).toBe(0);
  });

  it('exits 1 on an error-severity finding', () => {
    expect(lintExitCode({ code: 1, findings: [error], summary: null })).toBe(1);
  });

  it('passes the code through when codelinter printed no report at all', () => {
    expect(lintExitCode({ code: 2, findings: [], summary: null })).toBe(2);
    expect(lintExitCode({ code: 1, findings: [], summary: { defects: 0, errors: 0, warnings: 0, suggestions: 0 } })).toBe(0);
  });

  it('treats a non-zero exit without a report as a failed run, not a clean one', () => {
    expect(lintFailed({ code: 1, findings: [], summary: null })).toBe(true);
    expect(lintFailed({ code: 0, findings: [], summary: null })).toBe(false);
    expect(lintFailed({ code: 1, findings: [warning], summary: null })).toBe(false);
  });

  it('counts the findings when there is no summary line', () => {
    expect(lintTotals({ findings: [warning, error], summary: null })).toEqual({ defects: 2, errors: 1, warnings: 1, suggestions: 0 });
  });
});

describe('formatLongDevice', () => {
  it('appends what the device reports, naming the HarmonyOS version', () => {
    const line = formatLongDevice(
      { serial: '127.0.0.1:5555', status: 'Connected', connection: 'TCP' },
      {
        serial: '127.0.0.1:5555',
        osFamily: 'HarmonyOS',
        osDistVersion: '6.1.0',
        sdkApiVersion: '24',
        abi: 'x86_64',
        deviceType: 'phone',
        model: 'emulator',
        osFullName: 'OpenHarmony-6.1.1.125',
        display: null,
      },
    );
    expect(line).toBe(
      '127.0.0.1:5555\tTCP\tConnected\tos="HarmonyOS 6.1.0"\tapi=24\tabi=x86_64\ttype=phone\tmodel=emulator\tfullname=OpenHarmony-6.1.1.125',
    );
  });

  it('keeps the plain columns for a device it could not query', () => {
    expect(formatLongDevice({ serial: 'X', status: 'Offline', connection: 'USB' }, undefined)).toBe('X\tUSB\tOffline');
  });
});

describe('hdcPassthroughArgv', () => {
  afterEach(() => {
    delete process.env.ONIRO_DEVICE_SERIAL;
  });

  it('addresses device commands at --device or ONIRO_DEVICE_SERIAL', () => {
    expect(hdcPassthroughArgv(['shell', 'ls'], 'A')).toEqual(['-t', 'A', 'shell', 'ls']);
    process.env.ONIRO_DEVICE_SERIAL = 'B';
    expect(hdcPassthroughArgv(['shell', 'ls'])).toEqual(['-t', 'B', 'shell', 'ls']);
    expect(hdcPassthroughArgv(['list', 'targets'])).toEqual(['list', 'targets']);
  });

  it('leaves an explicit -t alone', () => {
    process.env.ONIRO_DEVICE_SERIAL = 'B';
    expect(hdcPassthroughArgv(['-t', 'C', 'shell', 'ls'])).toEqual(['-t', 'C', 'shell', 'ls']);
  });
});
