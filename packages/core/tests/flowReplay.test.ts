import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { replayFlow, nearMatches, summarizeDivergenceLayout } from '../src/flow/replay.js';
import { recordFlow } from '../src/flow/record.js';
import { parseSelector } from '../src/hdc/selector.js';
import type { Flow } from '../src/flow/flowFile.js';
import { APP, fakeDevice, pruned, rawHome, rawPage1, rawPage2, type FakeDevice } from './_helpers/flowProbe.js';

const isWin = process.platform === 'win32';

const flow: Flow = {
  version: 1,
  bundle: APP,
  steps: [
    { action: 'inputText', selector: 'type=TextInput,hint=Your name', text: 'Ann' },
    { action: 'click', selector: 'type=Button,text=Continue', expect: 'type=Text,text=Hello Ann' },
    { action: 'click', selector: 'type=Text,text=Banana', expect: 'type=Text,text=Picked: Banana' },
  ],
};

describe('divergence helpers', () => {
  it('nearMatches lists elements failing exactly one clause', () => {
    const tree = pruned(rawPage1('', false, 'Next'));
    expect(nearMatches(tree, parseSelector('type=Button,text=Continue'))).toEqual([
      { element: 'Button "Next" #continueBtn at 0.500,0.305', differs: 'text=Continue' },
    ]);
    expect(nearMatches(tree, parseSelector('text=Continue'))).toEqual([]);
  });

  it('summarizeDivergenceLayout keeps to the app and says when it is not on screen', () => {
    const page = summarizeDivergenceLayout({ display: { width: 1080, height: 2400 }, tree: pruned(rawPage1('', false)) }, APP);
    expect(page).toMatchObject({ appOnScreen: true, lockScreen: false, keyboard: false, elementCount: 3 });
    expect(page.windows).toEqual([{ windowId: 100, bundle: APP }]);
    expect(summarizeDivergenceLayout({ display: null, tree: pruned(rawHome()) }, APP)).toMatchObject({
      appOnScreen: false,
      elements: ['Text "Clock" at 0.185,0.221'],
    });
  });
});

describe.skipIf(isWin)('replayFlow (stand-in hdc)', () => {
  let dev: FakeDevice;
  const opts = () => ({ config: staticConfig({ hdcPath: dev.hdc }), wake: false, stepTimeoutMs: 400, pollMs: 20 });

  beforeEach(() => {
    dev = fakeDevice();
  });
  afterEach(() => dev.cleanup());

  it('runs every step through input and wait, and saves a screenshot per step', async () => {
    dev.show(rawPage1('', false));
    dev.queue(rawPage1('Ann', true), rawPage2('Ann', 'none'), rawPage2('Ann', 'Banana'));
    const shots = path.join(dev.root, 'shots');
    const seen: number[] = [];
    const r = await replayFlow({ ...opts(), flow, screenshotsDir: shots, onStep: (s) => seen.push(s.index) });
    expect(r).toMatchObject({ ok: true, outcome: 'passed', range: [0, 2], warnings: [] });
    expect(seen).toEqual([0, 1, 2]);
    expect(dev.inputs()).toEqual([
      "uitest uiInput inputText 540 564 'Ann'",
      'uitest uiInput click 540 732',
      'uitest uiInput click 540 814',
    ]);
    expect(r.steps.map((s) => s.target)).toEqual([
      'TextInput "hint: Your name" #nameInput at 0.500,0.235',
      'Button "Continue" #continueBtn at 0.500,0.305',
      'Text "Banana" at 0.500,0.339',
    ]);
    expect(fs.readdirSync(shots).sort()).toEqual(['step-00.jpeg', 'step-01.jpeg', 'step-02.jpeg']);
  });

  it('stops where the selector is not found, with near matches, the screen and a screenshot', async () => {
    dev.show(rawPage1('', false, 'Next'));
    dev.queue(rawPage1('Ann', true, 'Next'));
    const shots = path.join(dev.root, 'shots');
    const r = await replayFlow({ ...opts(), flow, screenshotsDir: shots });
    expect(r).toMatchObject({
      ok: false,
      outcome: 'diverged',
      failedStep: 1,
      reason: 'not-found',
      selector: 'type=Button,text=Continue',
      message: 'No element matching type=Button,text=Continue appeared within 400 ms.',
      nearMatches: [{ element: 'Button "Next" #continueBtn at 0.500,0.305', differs: 'text=Continue' }],
      screenshot: path.join(shots, 'failed-step-01.jpeg'),
    });
    expect(r.layout).toMatchObject({ appOnScreen: true, keyboard: true });
    expect(r.layout!.elements).toContain('Button "Next" #continueBtn at 0.500,0.305');
    expect(r.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(dev.inputs()).toHaveLength(1);
  });

  it('reports expect-not-found when the step ran but its result did not show', async () => {
    dev.show(rawPage1('', false));
    dev.queue(rawPage1('Ann', true), rawPage1('Ann', true));
    const r = await replayFlow({ ...opts(), flow, to: 1, divergenceScreenshot: false });
    expect(r).toMatchObject({ outcome: 'diverged', failedStep: 1, reason: 'expect-not-found', selector: 'type=Text,text=Hello Ann' });
    expect(r.screenshot).toBeUndefined();
  });

  it('reports wrong-screen when the app is not on screen', async () => {
    dev.show(rawHome());
    const r = await replayFlow({ ...opts(), flow, divergenceScreenshot: false });
    expect(r).toMatchObject({ outcome: 'diverged', failedStep: 0, reason: 'wrong-screen' });
    expect(r.message).toMatch(/^com\.example\.flowprobe is not on screen \(windows: com\.ohos\.sceneboard\)\. No element/);
  });

  it('acts on the fallback point when asked to, and on a point-only step', async () => {
    dev.show(rawPage1('', false, 'Next'));
    const pointed: Flow = {
      version: 1,
      steps: [
        { action: 'click', selector: 'type=Button,text=Continue', fallback: { fx: 0.5, fy: 0.305 } },
        { action: 'longClick', fallback: { fx: 0.1, fy: 0.9 } },
        { action: 'keyEvent', key: 'Back', selector: 'id=title' },
      ],
    };
    const r = await replayFlow({ ...opts(), flow: pointed, fallback: true });
    expect(r.outcome).toBe('passed');
    expect(r.steps.map((s) => s.usedFallback)).toEqual([true, true, undefined]);
    expect(dev.inputs()).toEqual(['uitest uiInput click 540 732', 'uitest uiInput longClick 108 2160', 'uitest uiInput keyEvent Back']);
  });

  it('runs a --from/--to range, and refuses one outside the flow', async () => {
    dev.show(rawPage2('Ann', 'none'));
    dev.queue(rawPage2('Ann', 'Banana'));
    const r = await replayFlow({ ...opts(), flow, from: 2 });
    expect(r).toMatchObject({ outcome: 'passed', range: [2, 2] });
    expect(r.steps.map((s) => s.index)).toEqual([2]);
    expect(await replayFlow({ ...opts(), flow, from: 2, to: 5 })).toMatchObject({
      outcome: 'error',
      error: "Step range 2..5 is outside the flow's steps 0..2.",
    });
  });

  it('cannot run without a device', async () => {
    dev.disconnect();
    const saved = process.env.ONIRO_DEVICE_SERIAL;
    delete process.env.ONIRO_DEVICE_SERIAL;
    try {
      expect(await replayFlow({ ...opts(), flow })).toMatchObject({ ok: false, outcome: 'error', error: expect.stringMatching(/No connected device/) });
    } finally {
      if (saved !== undefined) process.env.ONIRO_DEVICE_SERIAL = saved;
    }
  });
});

describe.skipIf(isWin)('recordFlow (stand-in hdc)', () => {
  let dev: FakeDevice;
  beforeEach(() => {
    dev = fakeDevice();
  });
  afterEach(() => dev.cleanup());

  it('runs the recorder, stops it, and converts what it wrote with the touch and layout times', async () => {
    const fixtures = path.join(__dirname, 'fixtures', 'flow');
    fs.copyFileSync(path.join(fixtures, 'record.csv'), path.join(dev.root, 'rec', 'record.csv'));
    fs.copyFileSync(path.join(fixtures, 'touches.hilog'), path.join(dev.root, 'rec', 'touches.hilog'));
    const layouts = [
      rawPage1('', true), rawPage1('bo', true), rawPage1('bob', true), rawPage2('bob', 'none'),
      rawPage2('bob', 'Cherry'), rawPage2('bob', 'Cherry'), rawPage1('bob', true),
    ];
    const clock = ['02.093', '03.813', '05.177', '06.525', '08.725', '10.017', '11.385'];
    const stat: string[] = [];
    layouts.forEach((raw, i) => {
      const name = `layout_148348410105_${i + 1}.json`;
      fs.writeFileSync(path.join(dev.root, 'rec', name), JSON.stringify(raw));
      stat.push(`2026-11-05 14:42:${clock[i]}001116 +0100|/data/local/tmp/${name}`);
    });
    fs.writeFileSync(path.join(dev.root, 'rec', 'stat.txt'), `${stat.join('\n')}\n`);
    fs.writeFileSync(path.join(dev.root, 'dumps', '1.json'), JSON.stringify(rawPage1('', false)));
    fs.writeFileSync(path.join(dev.root, 'dumps', '2.json'), JSON.stringify(rawPage1('bob', true)));
    const raw = path.join(dev.root, 'raw');

    const counts: number[] = [];
    const r = await recordFlow({
      config: staticConfig({ hdcPath: dev.hdc }),
      wake: false,
      durationMs: 60,
      pollMs: 10,
      rawDir: raw,
      onEvents: (n) => counts.push(n),
    });
    expect(r.warnings).toEqual([]);
    expect(r.events).toBe(7);
    expect(counts).toContain(7);
    expect(r.flow).toMatchObject({ bundle: APP, ability: 'EntryAbility', device: { api: 26, display: { width: 1080, height: 2400 } } });
    expect(r.flow.steps.map((s) => [s.action, s.selector ?? s.key, s.expect])).toEqual([
      ['inputText', 'type=TextInput,id=nameInput', undefined],
      ['click', 'type=Button,id=continueBtn', 'type=Text,id=greeting'],
      ['click', 'type=Text,text=Cherry', 'type=Text,text=Picked: Cherry'],
      ['keyEvent', 'Back', 'type=Text,id=title'],
    ]);
    expect(fs.existsSync(path.join(dev.root, 'stopped'))).toBe(true);
    expect(fs.readdirSync(raw)).toEqual(expect.arrayContaining(['record.csv', 'recording.json', 'console.txt', 'layout_148348410105_7.json']));
  });
});
