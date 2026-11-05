import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatDivergence, formatReplayStep, replayExitCode } from '../src/commands/replay.js';
import { runCli } from './_helpers/runCli.js';
import { fakeDevice, rawPage1, rawPage2, type FakeDevice } from '../../core/tests/_helpers/flowProbe.js';

const isWin = process.platform === 'win32';

const flow = {
  version: 1,
  bundle: 'com.example.flowprobe',
  steps: [
    { action: 'click', selector: 'type=Button,text=Continue', expect: 'id=greeting' },
    { action: 'click', selector: 'type=Text,text=Banana' },
  ],
};

describe('replay output', () => {
  it('maps the outcome to the exit code', () => {
    expect(replayExitCode({ outcome: 'passed' })).toBe(0);
    expect(replayExitCode({ outcome: 'diverged' })).toBe(1);
    expect(replayExitCode({ outcome: 'error' })).toBe(2);
  });

  it('prints a step per line and the divergence with what was on screen', () => {
    expect(formatReplayStep({ index: 2, action: 'click', selector: 'id=a', ok: false, durationMs: 1234, usedFallback: true })).toBe(
      '[2] click id=a (at the recorded point)  FAILED  1.2 s',
    );
    const text = formatDivergence({
      ok: false, outcome: 'diverged', bundle: 'com.x', range: [0, 1], steps: [], warnings: [],
      failedStep: 1, reason: 'not-found', message: 'No element matching id=a appeared within 10 ms.',
      screenshot: '/tmp/s.jpeg', nearMatches: [{ element: 'Button "B" #a', differs: 'text=A' }],
      layout: { windows: [], appOnScreen: true, lockScreen: false, keyboard: true, elements: ['Button "B" #a'], elementCount: 2 },
    });
    expect(text).toBe(
      [
        'Diverged at step 1 (not-found): No element matching id=a appeared within 10 ms.',
        '  screenshot: /tmp/s.jpeg',
        '  near match: Button "B" #a (differs in text=A)',
        '  on screen in com.x (2 element(s), keyboard up):',
        '    Button "B" #a',
        '    … 1 more',
      ].join('\n'),
    );
  });
});

describe.skipIf(isWin)('oniro-app replay', () => {
  let dev: FakeDevice;
  let file: string;
  const run = (...args: string[]) =>
    runCli(['replay', file, '--no-wake', '--step-timeout', '400', ...args], { ONIRO_HDC: dev.hdc, ONIRO_DEVICE_SERIAL: '' });

  beforeEach(() => {
    dev = fakeDevice();
    file = path.join(dev.root, 'flow.json');
    fs.writeFileSync(file, JSON.stringify(flow));
  });
  afterEach(() => dev.cleanup());

  it('exits 0 when every step ran', () => {
    dev.show(rawPage1('', false));
    dev.queue(rawPage2('', 'none'), rawPage2('', 'Banana'));
    const r = run();
    expect(r.stdout).toMatch(/^\[0\] click type=Button,text=Continue {2}ok/m);
    expect(r.stdout).toContain('Flow passed: 2 step(s).');
    expect(r.status).toBe(0);
  });

  it('exits 1 with the divergence report as JSON', () => {
    dev.show(rawPage1('', false, 'Next'));
    const r = run('--json', '--screenshots', path.join(dev.root, 'shots'));
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      outcome: 'diverged',
      failedStep: 0,
      reason: 'not-found',
      selector: 'type=Button,text=Continue',
      nearMatches: [{ differs: 'text=Continue' }],
      screenshot: path.join(dev.root, 'shots', 'failed-step-00.jpeg'),
    });
  });

  it('exits 2 for an invalid flow file or no device', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, steps: [{ action: 'tap' }] }));
    let r = run('--json');
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/not a valid flow:\n {2}steps\[0\]\.action: expected one of/);
    fs.writeFileSync(file, JSON.stringify(flow));
    dev.disconnect();
    r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/No connected device/);
  });
});
