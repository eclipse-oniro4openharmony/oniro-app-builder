import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  installApp: vi.fn(),
}));
const smokeMocks = vi.hoisted(() => ({
  launchApp: vi.fn(),
  smokeCheck: vi.fn(),
  wakeAndUnlock: vi.fn(),
  applyChanges: vi.fn(),
  latestCrash: vi.fn(),
}));

vi.mock('@oniroproject/core', async () => {
  const actual = await vi.importActual<typeof import('@oniroproject/core')>('@oniroproject/core');
  return { ...actual, installApp: mocks.installApp, ...smokeMocks };
});

import { noopLogger, noopProgress, staticConfig } from '@oniroproject/core';
import { registerAppCommand } from '../src/commands/app.js';
import { setRuntime } from '../src/lib/runtime.js';

describe('app install', () => {
  beforeEach(() => {
    mocks.installApp.mockReset();
    mocks.installApp.mockResolvedValue({ installed: true, bundleName: '', hapPath: '', output: '' });
    setRuntime({ config: staticConfig(), logger: noopLogger, progress: noopProgress });
  });

  afterEach(() => {
    setRuntime(null);
  });

  it('forwards --device to installApp', async () => {
    const program = new Command();
    registerAppCommand(program);

    await program.parseAsync(
      ['app', 'install', 'project', '--hap', 'app.hap', '--device', 'ABC123'],
      { from: 'user' },
    );

    expect(mocks.installApp).toHaveBeenCalledWith({
      config: expect.any(Object),
      projectDir: path.resolve('project'),
      hapPath: 'app.hap',
      deviceSerial: 'ABC123',
      logger: noopLogger,
    });
  });
});

const smokeResult = (passed: boolean) => ({
  passed,
  failures: passed ? [] : ['the screen is blank'],
  pid: 42,
  alive: true,
  blankScreen: !passed,
  blankScore: passed ? 0.97 : 1,
  screenshot: '/tmp/s.jpeg',
  crash: null,
  crashChecked: false,
  delayMs: 500,
});

describe('app launch / apply --smoke', () => {
  let out: string;
  beforeEach(() => {
    for (const m of Object.values(smokeMocks)) m.mockReset();
    smokeMocks.wakeAndUnlock.mockResolvedValue({ woke: false, unlocked: false, locked: false });
    smokeMocks.launchApp.mockResolvedValue(undefined);
    smokeMocks.applyChanges.mockResolvedValue({
      method: 'replace',
      preInstallPid: 1,
      postInstallPid: null,
      replaced: true,
      cacheCleared: false,
    });
    setRuntime({ config: staticConfig(), logger: noopLogger, progress: noopProgress });
    out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      out += String(s);
      return true;
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    setRuntime(null);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const run = async (args: string[]): Promise<void> => {
    const program = new Command();
    registerAppCommand(program);
    await program.parseAsync(args, { from: 'user' });
  };

  it('wakes the screen, launches, smoke-checks with a decoder and the faultlog reader, and prints JSON', async () => {
    smokeMocks.smokeCheck.mockResolvedValue(smokeResult(true));
    await run(['app', 'launch', '--bundle', 'com.x', '--smoke', '--smoke-delay', '500', '--json', '--device', 'S1']);
    expect(smokeMocks.wakeAndUnlock).toHaveBeenCalledWith(expect.objectContaining({ deviceSerial: 'S1' }));
    expect(smokeMocks.wakeAndUnlock.mock.invocationCallOrder[0]).toBeLessThan(
      smokeMocks.launchApp.mock.invocationCallOrder[0]!,
    );
    const opts = smokeMocks.smokeCheck.mock.calls[0]![0];
    expect(opts).toMatchObject({ bundle: 'com.x', delayMs: 500, deviceSerial: 'S1' });
    expect(opts.since).toBeInstanceOf(Date);
    expect(typeof opts.decodeGreyscale).toBe('function');
    // The crash probe is the faultlog reader: it waits for a faultlog only when the app died.
    smokeMocks.latestCrash.mockResolvedValue(null);
    // The launch is passed as "seconds ago" (plus 2 s slack), read on the device's clock.
    const since = new Date(Date.now() - 10_000);
    await opts.crashProbe({ config: opts.config, bundle: 'com.x', since, alive: true, deviceSerial: 'S1' });
    await opts.crashProbe({ config: opts.config, bundle: 'com.x', since, alive: false, deviceSerial: 'S1' });
    const calls = smokeMocks.latestCrash.mock.calls.map((c) => [c[0].waitMs, c[0].since, c[0].deviceSerial]);
    expect(calls.map(([w, , d]) => [w, d])).toEqual([
      [0, 'S1'],
      [15_000, 'S1'],
    ]);
    for (const [, ago] of calls) {
      expect(typeof ago).toBe('number');
      expect(ago).toBeGreaterThanOrEqual(12);
      expect(ago).toBeLessThan(13);
    }
    expect(opts.screenshotPath).toMatch(/oniro-smoke-com\.x-\d+\.jpeg$/);
    expect(JSON.parse(out)).toEqual({ bundle: 'com.x', smoke: smokeResult(true) });
    expect(process.exitCode).toBeUndefined();
  });

  it('names the crash in the smoke line', async () => {
    smokeMocks.smokeCheck.mockResolvedValue({
      ...smokeResult(false),
      failures: ['js_crash: RangeError'],
      alive: false,
      blankScreen: null,
      crash: { kind: 'js_crash', reason: 'RangeError', file: 'entry/src/main/ets/pages/Index.ets', line: 8 },
      crashChecked: true,
    });
    await run(['app', 'launch', '--bundle', 'com.x', '--smoke']);
    expect(out).toContain('js_crash (RangeError) at entry/src/main/ets/pages/Index.ets:8');
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when the smoke check fails', async () => {
    smokeMocks.smokeCheck.mockResolvedValue(smokeResult(false));
    await run(['app', 'launch', '--bundle', 'com.x', '--smoke']);
    expect(out).toContain('smoke: FAILED (the screen is blank)');
    expect(process.exitCode).toBe(1);
  });

  it('launches without a smoke check unless asked', async () => {
    await run(['app', 'launch', '--bundle', 'com.x']);
    expect(smokeMocks.smokeCheck).not.toHaveBeenCalled();
    expect(smokeMocks.wakeAndUnlock).not.toHaveBeenCalled();
  });

  it('apply --smoke launches the installed bundle and adds the verdict to the JSON', async () => {
    smokeMocks.smokeCheck.mockResolvedValue(smokeResult(false));
    await run(['app', 'apply', 'p', '--bundle', 'com.x', '--smoke', '--smoke-screenshot', 'shot.jpeg', '--json']);
    expect(smokeMocks.launchApp).toHaveBeenCalledWith(expect.objectContaining({ bundleName: 'com.x' }));
    expect(smokeMocks.smokeCheck.mock.calls[0]![0].screenshotPath).toBe(path.resolve('shot.jpeg'));
    expect(JSON.parse(out)).toMatchObject({ method: 'replace', smoke: { passed: false } });
    expect(process.exitCode).toBe(1);
  });
});
