import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LayoutNode } from '../src/hdc/dump.js';
import { APP, DISPLAY, IME, pruned, rawPage1, rawPage2 } from './_helpers/flowProbe.js';
import {
  alignTouches,
  elementAt,
  expectFor,
  fieldSelector,
  flowFromRecording,
  keystrokeChar,
  keystrokeName,
  parseUiRecordLines,
  type RecordingTimes,
  type UiRecordEvent,
} from '../src/flow/recording.js';
import { parseDeviceTime, parseRecorderForeground, parseTouchDowns } from '../src/flow/record.js';
import { flattenLayout } from '../src/hdc/dump.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'flow');
const display = DISPLAY;
const page1 = (name: string, kb: boolean): LayoutNode => pruned(rawPage1(name, kb));
const page2 = (name: string, picked: string): LayoutNode => pruned(rawPage2(name, picked));

// fixtures/flow/record.csv: tap the name field, tap b, o, b on the soft keyboard, tap Continue, tap
// Cherry on the next page, press Back, about a second apart. What each layout uitest saved showed
// (it writes an event, and dumps, once the next touch has started): see the layout map below.
const events = parseUiRecordLines(fs.readFileSync(path.join(FIXTURES, 'record.csv'), 'utf8'));
const file = (n: number): string => `/data/local/tmp/layout_148348410105_${n}.json`;
const layouts = new Map<string, LayoutNode>([
  [file(1), page1('', true)],
  [file(2), page1('bo', true)],
  [file(3), page1('bob', true)],
  [file(4), page2('bob', 'none')],
  [file(5), page2('bob', 'Cherry')],
  [file(6), page2('bob', 'Cherry')],
  [file(7), page1('bob', true)],
]);
const START = '2026-11-05 14:41:57.533855039 +0100';
const t = (clock: string): number => parseDeviceTime(`2026-11-05 ${clock} +0100`)!;
const times: RecordingTimes = {
  initial: t('14:41:57.533'),
  touchDowns: parseTouchDowns(fs.readFileSync(path.join(FIXTURES, 'touches.hilog'), 'utf8'), START),
  layouts: new Map(
    ['14:42:02.093', '14:42:03.813', '14:42:05.177', '14:42:06.525', '14:42:08.725', '14:42:10.017', '14:42:11.385'].map(
      (c, i) => [file(i + 1), t(c)],
    ),
  ),
};
const base = {
  events,
  layouts,
  initial: page1('', false),
  final: page1('bob', true),
  display,
  imeBundles: [IME],
};

describe('parseUiRecordLines', () => {
  it('reads the JSON lines uitest writes to record.csv and skips the rest', () => {
    expect(events.map((e) => e.OP_TYPE)).toEqual(['click', 'click', 'click', 'click', 'click', 'click', 'back']);
    expect(events[0]!.fingerList![0]!.W1_ID).toBe('nameInput');
    expect(parseUiRecordLines('Started Recording\n{"OP_TYPE":"click"}\n{"OP_TYPE":"cli\n')).toEqual([{ OP_TYPE: 'click' }]);
  });
});

describe('device clock helpers', () => {
  it('parses date and stat timestamps, and touch-downs from hilog, ignoring the hdc log of the grep itself', () => {
    expect(parseDeviceTime('2026-11-05 14:41:57.533855039 +0100')).toBe(Date.parse('2026-11-05T13:41:57.533Z'));
    expect(parseDeviceTime('nope')).toBeUndefined();
    const hilog =
      "11-05 14:42:13.424  3149 20589 I C02d13/HDC_LOG: [async_cmd.cpp:251] ExecuteCommand cmd:hilog -x | grep -F 'ServerMsgHandler: [P:D:'\n" +
      '11-05 14:42:00.689  2401  2694 I C02801/ServerMsgHandler: [P:D:2138|334]Check : current PointerEvent\n' +
      '11-05 14:42:00.791  2401  2694 I C02801/ServerMsgHandler: [P:U:2139|334]Check : current PointerEvent\n' +
      '11-05 14:40:00.000  2401  2694 I C02801/ServerMsgHandler: [P:D:2000|334]Check : before the recording\n';
    expect(parseTouchDowns(hilog, START, t('14:41:57.533'))).toEqual([t('14:42:00.689')]);
    expect(times.touchDowns).toHaveLength(6);
  });

  it('reads the foreground app off the recorder console', () => {
    expect(parseRecorderForeground('windowBounds : (0,0,1080,2400)\nCurrent ForAbility :com.example.flowprobe, EntryAbility\n')).toEqual({
      bundle: APP,
      ability: 'EntryAbility',
    });
    expect(parseRecorderForeground('Started Recording')).toBeUndefined();
  });
});

describe('alignTouches', () => {
  it('gives each pointer event its touch-down, back/home taking none or one', () => {
    const ev = (OP_TYPE: string, extra: Partial<UiRecordEvent> = {}): UiRecordEvent => ({ OP_TYPE, ...extra });
    const list = [ev('click'), ev('key'), ev('doubleClick'), ev('back'), ev('swipe')];
    expect(alignTouches(list, [1, 2, 3, 4])).toEqual(new Map([[0, 1], [2, 2], [4, 4]]));
    expect(alignTouches(list, [1, 2, 3, 4, 5])).toEqual(new Map([[0, 1], [2, 2], [3, 4], [4, 5]]));
    expect(alignTouches(list, [1, 2])).toBeUndefined();
  });
});

describe('keystrokes', () => {
  it('maps KeyCode ids to characters and key names', () => {
    expect(keystrokeChar([2047, 2017])).toBe('A');
    expect(keystrokeChar([2030])).toBe('n');
    expect(keystrokeChar([2005])).toBe('5');
    expect(keystrokeChar([2050])).toBe(' ');
    expect(keystrokeChar([2072, 2017])).toBeUndefined();
    expect(keystrokeChar([2054])).toBeUndefined();
    expect(keystrokeName([2054])).toBe('Enter');
    expect(keystrokeName([2072, 2017])).toBe('Ctrl+2017');
  });
});

describe('layout helpers', () => {
  it('elementAt finds the topmost element under a point, not what the keyboard covers', () => {
    expect(elementAt(page2('bob', 'none'), { fx: 0.5, fy: 0.408 })).toMatchObject({ type: 'Text', text: 'Cherry' });
    expect(elementAt(page1('', true), { fx: 0.601, fy: 0.813 })).toMatchObject({ type: 'Text', text: 'b' });
    expect(elementAt(page1('', false), { fx: 0.5, fy: 0.9 })).toBeUndefined();
  });

  it('fieldSelector does not depend on the text typed into the field', () => {
    const tree = page1('bob', true);
    const field = flattenLayout(tree).find((n) => n.type === 'TextInput')!;
    expect(fieldSelector(tree, field)).toBe('type=TextInput,id=nameInput');
    const { id: _id, ...noId } = field;
    const anonymous: LayoutNode = { children: [{ ...noId }, { ...noId, b: [0, 0.5, 1, 0.6], c: [0.5, 0.55] }] };
    expect(fieldSelector(anonymous, { ...noId, b: [0, 0.5, 1, 0.6] })).toBe('type=TextInput,hint=Your name[1]');
  });

  it('expectFor names an element that appeared, ids first, else a new text', () => {
    expect(expectFor(page1('bob', true), page2('bob', 'none'), { bundle: APP })).toBe('type=Text,id=greeting');
    expect(expectFor(page2('bob', 'none'), page2('bob', 'Cherry'), { bundle: APP })).toBe('type=Text,text=Picked: Cherry');
    expect(expectFor(page2('bob', 'none'), page2('bob', 'none'), { bundle: APP })).toBeUndefined();
  });
});

describe('flowFromRecording', () => {
  it('places events and layouts on the device clock: the right element for each touch, and what appeared after it', () => {
    const { flow, warnings } = flowFromRecording({ ...base, times, api: 26 });
    expect(warnings).toEqual([]);
    expect(flow).toEqual({
      version: 1,
      bundle: APP,
      ability: 'EntryAbility',
      device: { api: 26, display },
      steps: [
        // The tap on the field and the three keyboard taps: one inputText, the text read off the field.
        { action: 'inputText', text: 'bob', selector: 'type=TextInput,id=nameInput' },
        // uitest itself reported the List of the next page here (it hit-tested once Cherry was tapped).
        { action: 'click', selector: 'type=Button,id=continueBtn', fallback: { fx: 0.5, fy: 0.305 }, expect: 'type=Text,id=greeting' },
        { action: 'click', selector: 'type=Text,text=Cherry', fallback: { fx: 0.5, fy: 0.408 }, expect: 'type=Text,text=Picked: Cherry' },
        { action: 'keyEvent', key: 'Back', expect: 'type=Text,id=title' },
      ],
    });
  });

  it('without matching touch times, warns and takes the layouts in event order', () => {
    const { flow, warnings } = flowFromRecording({ ...base, times: { ...times, touchDowns: times.touchDowns.slice(2) } });
    expect(warnings).toEqual([expect.stringMatching(/7 pointer events do not match the 4 touch-downs/)]);
    // The layout saved before the Continue tap already shows the next page.
    expect(flow.steps[1]).toMatchObject({ action: 'click', selector: 'type=List,id=fruitList' });
  });

  it('turns typed keystrokes into inputText and other keys into keyEvent', () => {
    const key = (codes: number[], layout?: string): UiRecordEvent => ({
      OP_TYPE: 'key',
      KeyCode1: String(codes[0]),
      KeyCode2: codes[1] !== undefined ? String(codes[1]) : '',
      KeyCode3: '',
      ...(layout ? { FILEPAHT: layout } : {}),
    });
    // What `input --type inputText` (uitest inputText) records: shift+a, n, n as down/up line pairs, then Enter.
    const keys = [key([2047, 2017]), key([2017], 'k1'), key([2030]), key([2030], 'k2'), key([2030]), key([2030], 'k3'), key([2054]), key([2054], 'k4')];
    const typed = page1('Ann', true);
    const r = flowFromRecording({
      events: keys,
      layouts: new Map([['k1', typed], ['k2', typed], ['k3', typed], ['k4', typed]]),
      initial: page1('', true),
      display,
      imeBundles: [IME],
    });
    expect(r.flow.steps).toEqual([
      { action: 'inputText', text: 'Ann', selector: 'type=TextInput,id=nameInput' },
      { action: 'keyEvent', key: 'Enter' },
    ]);
    // No field on screen: the text comes from the keystrokes and types into whatever has focus.
    const none = flowFromRecording({ events: keys.slice(0, 6), layouts: new Map(), initial: page2('x', 'none'), display });
    expect(none.flow.steps).toEqual([{ action: 'inputText', text: 'Ann' }]);
    expect(none.warnings).toEqual([expect.stringMatching(/types into the focused field/)]);
  });

  it('records a swipe with its end point and skips what it cannot replay', () => {
    const finger = { X_POSI: '540', Y_POSI: '1200', X2_POSI: '540', Y2_POSI: '700' };
    const r = flowFromRecording({
      events: [
        { OP_TYPE: 'fling', fingerNumber: '1', fingerList: [finger] },
        { OP_TYPE: 'click', fingerNumber: '2', fingerList: [finger, finger] },
        { OP_TYPE: 'recent', fingerList: [finger] },
      ],
      layouts: new Map(),
      initial: page2('x', 'none'),
      display,
    });
    expect(r.flow.steps).toEqual([
      { action: 'swipe', selector: 'type=Text,text=Date', fallback: { fx: 0.5, fy: 0.5 }, to: { fx: 0.5, fy: 0.292 } },
    ]);
    expect(r.warnings).toEqual([expect.stringMatching(/2-finger "click"/), expect.stringMatching(/"recent" event: no step type/)]);
  });
});
