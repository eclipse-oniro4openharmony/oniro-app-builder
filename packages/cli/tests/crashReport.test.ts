import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeFaultLog } from '@oniroproject/core';
import { formatCrashVerdict, parseCrashSince, projectBundle } from '../src/lib/crashReport.js';
import { runCli } from './_helpers/runCli.js';

// Recorded faultlogs of a probe app (see packages/core/tests/fixtures/faultlog).
const FIXTURES = path.resolve(__dirname, '..', '..', 'core', 'tests', 'fixtures', 'faultlog');
const JS = path.join(FIXTURES, 'jscrash-com.example.crashprobe-20010066-20261105123257298.log');
const RECORD = path.join(FIXTURES, 'cppcrash-16917-1793878741472.json');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseCrashSince', () => {
  it('reads seconds and ISO times', () => {
    expect(parseCrashSince(undefined)).toBeUndefined();
    expect(parseCrashSince('30')).toBe(30);
    expect(parseCrashSince('2.5')).toBe(2.5);
    expect(parseCrashSince('2026-11-05T12:30:00+01:00')).toEqual(new Date('2026-11-05T11:30:00Z'));
  });

  it('rejects anything else', () => {
    for (const bad of ['', '-1', '5s', 'yesterday', '2026-13-45']) expect(() => parseCrashSince(bad)).toThrow(/--since/);
  });
});

describe('projectBundle', () => {
  it('reads the bundle of a project and nothing outside one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-crash-'));
    dirs.push(dir);
    expect(projectBundle(dir)).toBeUndefined();
    fs.mkdirSync(path.join(dir, 'AppScope'));
    fs.writeFileSync(path.join(dir, 'AppScope', 'app.json5'), "{ app: { bundleName: 'com.example.crashprobe' } }");
    expect(projectBundle(dir)).toBe('com.example.crashprobe');
  });
});

describe('formatCrashVerdict', () => {
  it('prints the error, where it happened and the stack of a JS crash', () => {
    const text = formatCrashVerdict(analyzeFaultLog(fs.readFileSync(JS, 'utf8'), { path: '/data/log/faultlog/faultlogger/x.log' }));
    expect(text).toBe([
      'CRASH js_crash, high confidence: com.example.crashprobe pid 9331 at 2026-11-05 12:32:57.298',
      'RangeError: crashprobe: config too short (3)',
      'At entry/src/main/ets/pages/Index.ets:8:13',
      'Top frame: at parseConfig entry (entry/src/main/ets/pages/Index.ets:8:13)',
      'Stack:',
      '  at parseConfig entry (entry/src/main/ets/pages/Index.ets:8:13)',
      '  at aboutToAppear entry (entry/src/main/ets/pages/Index.ets:14:34)',
      'Faultlog: /data/log/faultlog/faultlogger/x.log',
      '',
    ].join('\n'));
  });

  it('prints the reason, the project frame and a capped stack of a native crash', () => {
    const text = formatCrashVerdict(analyzeFaultLog(fs.readFileSync(RECORD, 'utf8')));
    expect(text).toContain('CRASH cpp_crash, high confidence: com.example.crashprobe pid 16917');
    expect(text).toContain('Reason: Signal:SIGSEGV(SEGV_MAPERR)');
    expect(text).toContain('Project frame: #04 at aboutToAppear entry (entry/src/main/ets/pages/Index.ets:12:38)');
    expect(text).toMatch(/ {2}… \d+ more\n/);
  });
});

describe('logs crash --path', () => {
  it('prints the verdict of a local faultlog as JSON, without a device', () => {
    const r = runCli(['logs', 'crash', '--path', JS, '--json']);
    expect(r.status).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v).toMatchObject({ crashed: true, kind: 'js_crash', file: 'entry/src/main/ets/pages/Index.ets', line: 8, column: 13, path: JS, rawPath: JS });
  });

  it('rejects a bad --since before touching the device', () => {
    const r = runCli(['logs', 'crash', '--since', 'yesterday']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--since takes a number of seconds or an ISO 8601 time');
  });
});
