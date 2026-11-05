import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatPerfReport, perfExitCode } from '../src/commands/perf.js';
import { runCli } from './_helpers/runCli.js';
import { fakePerfDevice, PERF_APP, PERF_FIXTURE, type FakePerfDevice } from '../../core/tests/_helpers/perfDevice.js';

const isWin = process.platform === 'win32';

describe('perf output', () => {
  it('maps the capture and the gate to the exit code', () => {
    expect(perfExitCode({ ok: true }, { passed: true, failures: [] })).toBe(0);
    expect(perfExitCode({ ok: true }, { passed: false, failures: ['x'] })).toBe(1);
    expect(perfExitCode({ ok: false }, { passed: true, failures: [] })).toBe(2);
  });

  it('prints frames, startup, scenes and the failed thresholds', () => {
    const text = formatPerfReport(
      {
        bundle: 'com.x',
        pid: 7,
        durationMs: 5200,
        refreshRateHz: 60,
        frames: { total: 10, janky: 2, jankRate: 0.2, p50Ms: 5, p95Ms: 30, maxMs: 40, missedVsyncs: 3, longest: [{ atMs: 1500, ms: 40 }] },
        startup: { coldMs: 700, firstFrameMs: 50, processMs: 30, from: 'aa StartAbility', to: 'first frame' },
        mainThread: { busyMs: 900, cpuMs: null },
        scenes: [{ scene: 'APP_LIST_FLING', page: '/ets/pages/Index', maxFrameMs: 20, hitchMsPerS: 12.34 }],
        notes: ['a note'],
        trace: '/tmp/t.ftrace',
      },
      { passed: false, failures: ['Jank rate 0.2 (2/10 frames) is above 0.1.'] },
    );
    expect(text.split('\n')).toEqual([
      'com.x (pid 7): 5.2 s captured, display 60 Hz (16.7 ms per frame)',
      '  frames: 10, janky 2 (20.0%), p50 5 ms, p95 30 ms, max 40 ms, 3 vsync(s) missed',
      '  longest: 40 ms at +1.50 s',
      '  startup: cold 700 ms (aa StartAbility → first frame), process up after 30 ms, first frame 50 ms',
      '  main thread: 900 ms in traced work',
      '  RenderService APP_LIST_FLING /ets/pages/Index: max frame 20 ms, hitch 12.3 ms/s',
      '  trace: /tmp/t.ftrace',
      '  note: a note',
      'GATE FAILED: Jank rate 0.2 (2/10 frames) is above 0.1.',
    ]);
  });
});

describe('oniro-app perf summary', () => {
  it('summarises a saved trace and applies the thresholds', () => {
    let r = runCli(['perf', 'summary', PERF_FIXTURE, '--bundle', PERF_APP, '--launched', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      pid: 22334,
      frames: { total: 200, janky: 28 },
      startup: { coldMs: 778 },
      gate: { passed: true },
    });
    r = runCli(['perf', 'summary', PERF_FIXTURE, '--bundle', PERF_APP, '--launched', '--max-jank-rate', '0.1', '--max-startup-ms', '1000']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('GATE FAILED: Jank rate 0.14 (28/200 frames) is above 0.1.');
    expect(r.stdout).not.toContain('Cold start');
    r = runCli(['perf', 'summary', path.join(path.dirname(PERF_FIXTURE), 'missing.txt'), '--bundle', PERF_APP]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Could not read .*missing\.txt/);
  });

  it('rejects a jank rate outside 0..1', () => {
    const r = runCli(['perf', 'summary', PERF_FIXTURE, '--bundle', PERF_APP, '--max-jank-rate', '5']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/between 0 and 1/);
  });
});

describe.skipIf(isWin)('oniro-app perf trace', () => {
  let dev: FakePerfDevice;
  const run = (...args: string[]) => runCli(['perf', 'trace', '--bundle', PERF_APP, '--for', '10', ...args], { ONIRO_HDC: dev.hdc, ONIRO_DEVICE_SERIAL: '' });

  beforeEach(() => {
    dev = fakePerfDevice();
  });
  afterEach(() => dev.cleanup());

  it('exits 0 for a launch capture within the thresholds, 1 above them', () => {
    const out = path.join(dev.root, 'trace.ftrace');
    let r = run('--launch', '--ability', 'EntryAbility', '--no-wake', '--out', out, '--max-startup-ms', '1000', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, trace: out, startup: { coldMs: 778 }, gate: { passed: true } });
    r = run('--launch', '--ability', 'EntryAbility', '--no-wake', '--max-startup-ms', '500');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('GATE FAILED: Cold start 778 ms is above 500 ms.');
  });

  it('exits 2 when it could not capture', () => {
    let r = run('--categories', 'ace,bogus');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/hitrace could not start/);
    fs.writeFileSync(path.join(dev.root, 'targets.txt'), '[Empty]\n');
    r = run('--json');
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/No connected device/);
  });
});
