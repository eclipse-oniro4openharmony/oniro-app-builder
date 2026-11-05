import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import type { GreyImage } from '../src/image/hash.js';

// Each findRunningProcess call takes the next pid from this queue (the last one repeats).
let pids: Array<string | null> = [];
const takeScreenshot = vi.fn();
vi.mock('../src/hdc/app.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findRunningProcess: async ({ bundle }: { bundle: string }) => {
    const pid = pids.length > 1 ? pids.shift()! : pids[0]!;
    return pid === null ? null : { pid, name: bundle };
  },
}));
vi.mock('../src/hdc/screen.js', () => ({ takeScreenshot: (...a: unknown[]) => takeScreenshot(...a) }));

const { smokeCheck, smokeVerdict } = await import('../src/hdc/smoke.js');

const config = staticConfig({});
const JPEG = Buffer.from('not really a jpeg');

const image = (busy: boolean): GreyImage => {
  const data = new Uint8Array(100 * 200).fill(255);
  if (busy) for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  return { width: 100, height: 200, data };
};

beforeEach(() => {
  pids = [];
  takeScreenshot.mockReset();
  takeScreenshot.mockResolvedValue({ pixels: JPEG, width: 1080, height: 2400 });
});

describe('smokeVerdict', () => {
  it('passes only when the process lived, the screen drew and nothing crashed', () => {
    expect(smokeVerdict({ pid: 1, alive: true, blankScreen: false, crash: null })).toEqual({ passed: true, failures: [] });
    expect(smokeVerdict({ pid: 1, alive: true, blankScreen: null, crash: null }).passed).toBe(true);
    expect(smokeVerdict({ pid: null, alive: false, blankScreen: false, crash: null }).failures).toEqual([
      'the app process did not start',
    ]);
    expect(smokeVerdict({ pid: 1, alive: false, blankScreen: true, crash: { kind: 'js_crash' } }).failures).toEqual([
      'the app process died after launch',
      'the screen is blank',
      'a crash was recorded since launch',
    ]);
  });
});

describe('smokeCheck', () => {
  it('passes a running app that draws, and keeps the screenshot', async () => {
    pids = [null, '42'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
    const shot = path.join(dir, 's.jpeg');
    const decode = vi.fn(async () => image(true));
    const r = await smokeCheck({ config, bundle: 'com.x', delayMs: 0, screenshotPath: shot, decodeGreyscale: decode });
    expect(r).toMatchObject({ passed: true, pid: 42, alive: true, blankScreen: false, screenshot: shot, crash: null, crashChecked: false });
    expect(r.pidAfter).toBeUndefined();
    expect(fs.readFileSync(shot)).toEqual(JPEG);
    expect(decode).toHaveBeenCalledWith(JPEG);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails a blank screen', async () => {
    pids = ['42'];
    const r = await smokeCheck({ config, bundle: 'com.x', delayMs: 0, decodeGreyscale: async () => image(false) });
    expect(r).toMatchObject({ passed: false, blankScreen: true, blankScore: 1, screenshot: null });
    expect(r.failures).toEqual(['the screen is blank']);
  });

  it('fails when the process died, or came back as another pid', async () => {
    pids = ['42', null];
    let r = await smokeCheck({ config, bundle: 'com.x', delayMs: 0 });
    expect(r).toMatchObject({ passed: false, pid: 42, alive: false, pidAfter: null, blankScreen: null });
    pids = ['42', '43'];
    r = await smokeCheck({ config, bundle: 'com.x', delayMs: 0 });
    expect(r).toMatchObject({ alive: false, pidAfter: 43 });
  });

  it('fails when the process never appears', async () => {
    pids = [null];
    const r = await smokeCheck({ config, bundle: 'com.x', delayMs: 0, pidTimeoutMs: 0 });
    expect(r).toMatchObject({ passed: false, pid: null, alive: false });
    expect(r.failures).toEqual(['the app process did not start']);
  });

  it('asks the crash probe about the launch window and fails on a crash', async () => {
    pids = ['42'];
    const since = new Date('2026-11-05T10:00:00Z');
    const crashProbe = vi.fn(async () => ({ kind: 'js_crash', topFrame: 'Index.ets:5' }));
    const r = await smokeCheck({ config, bundle: 'com.x', since, delayMs: 0, deviceSerial: 'S1', crashProbe });
    expect(crashProbe).toHaveBeenCalledWith(
      expect.objectContaining({ config, bundle: 'com.x', since, alive: expect.any(Boolean), deviceSerial: 'S1' }),
    );
    expect(r).toMatchObject({ passed: false, crashChecked: true, crash: { kind: 'js_crash' } });
  });

  it('treats a failing probe or screenshot as nothing found', async () => {
    pids = ['42'];
    takeScreenshot.mockRejectedValue(new Error('snapshot_display failed'));
    const r = await smokeCheck({
      config,
      bundle: 'com.x',
      delayMs: 0,
      decodeGreyscale: async () => image(false),
      crashProbe: async () => {
        throw new Error('hidumper gone');
      },
    });
    expect(r).toMatchObject({ passed: true, blankScreen: null, crash: null, crashChecked: true, screenshot: null });
  });
});
