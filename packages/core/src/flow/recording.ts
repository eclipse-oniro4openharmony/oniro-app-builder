import type { DisplaySize } from '../hdc/display.js';
import { flattenLayout, listLayoutWindows, type FlatLayoutNode, type LayoutNode } from '../hdc/dump.js';
import { findKeyboardWindow } from '../hdc/ime.js';
import { selectorAttribute, type SelectorKey } from '../hdc/layoutQuery.js';
import { formatSelector, matchSelector, parseSelector, selectorFor, type SelectorClause, type RecordedElement } from '../hdc/selector.js';
import { FLOW_VERSION, type Flow, type FlowPoint, type FlowStep } from './flowFile.js';

/**
 * One finger of a pointer event, as `uitest uiRecord record` writes it: `W1_*`
 * and `W2_*` are widgets hit-tested at the down and up points, `X_POSI`, `Y_POSI`
 * and `X2_POSI`, `Y2_POSI` the down and up points in pixels. The points are
 * exact; the widgets are not reliable (see {@link flowFromRecording}).
 */
export interface UiRecordFinger {
  W1_BOUNDS?: string;
  W1_HIER?: string;
  W1_ID?: string;
  W1_Text?: string;
  W1_Type?: string;
  X_POSI?: string;
  Y_POSI?: string;
  X2_POSI?: string;
  Y2_POSI?: string;
  [field: string]: unknown;
}

/**
 * One line of uitest's `record.csv`, which is JSON Lines despite its name. Pointer
 * events carry `OP_TYPE` click, longClick, doubleClick, swipe, fling, drag, back,
 * home or recent, the foreground `BUNDLE` and `ABILITY`, and `fingerList`; key
 * events carry `OP_TYPE` key and `KeyCode1`..`KeyCode3` (each keystroke is two
 * lines, the second carrying the layout path). With `-l`, `FILEPAHT` (sic) is the
 * layout uitest dumped when it wrote the event.
 */
export interface UiRecordEvent {
  OP_TYPE: string;
  EVENT_TYPE?: string;
  BUNDLE?: string;
  ABILITY?: string;
  FILEPAHT?: string;
  fingerNumber?: string;
  fingerList?: UiRecordFinger[];
  KeyCode1?: string;
  KeyCode2?: string;
  KeyCode3?: string;
  [field: string]: unknown;
}

/** Parse the lines of uitest's `record.csv` (JSON Lines); other lines are skipped. Pure. */
export function parseUiRecordLines(text: string): UiRecordEvent[] {
  const out: UiRecordEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t) as UiRecordEvent;
      if (typeof ev.OP_TYPE === 'string') out.push(ev);
    } catch {
      // A line cut short when the recorder was stopped mid-write.
    }
  }
  return out;
}

// OpenHarmony KeyCode ids (@ohos.multimodalInput.keyCode).
const KEY_SHIFT = new Set([2047, 2048]);
const KEY_CHORD = new Set([2045, 2046, 2072, 2073, 2076, 2077]); // Alt, Ctrl, Meta (left and right)
const KEY_BACKSPACE = 2055;
const PUNCTUATION: Readonly<Record<number, string>> = {
  2010: '*', 2011: '#', 2043: ',', 2044: '.', 2050: ' ', 2056: '`', 2057: '-', 2058: '=', 2059: '[', 2060: ']',
  2061: '\\', 2062: ';', 2063: "'", 2064: '/', 2065: '@', 2066: '+',
};
const KEY_NAMES: Readonly<Record<number, string>> = {
  1: 'Home', 2: 'Back', 2012: 'Up', 2013: 'Down', 2014: 'Left', 2015: 'Right', 2045: 'Alt', 2046: 'Alt', 2047: 'Shift',
  2048: 'Shift', 2049: 'Tab', 2054: 'Enter', 2055: 'Delete', 2070: 'Escape', 2071: 'ForwardDelete', 2072: 'Ctrl',
  2073: 'Ctrl', 2076: 'Meta', 2077: 'Meta', 2081: 'MoveHome', 2082: 'MoveEnd',
};

/** The character a keystroke types (KeyCode ids, modifiers included), or undefined for other keys. Pure. */
export function keystrokeChar(codes: readonly number[]): string | undefined {
  if (codes.some((c) => KEY_CHORD.has(c))) return undefined;
  const shift = codes.some((c) => KEY_SHIFT.has(c));
  const keys = codes.filter((c) => !KEY_SHIFT.has(c));
  if (keys.length !== 1) return undefined;
  const k = keys[0]!;
  if (k >= 2017 && k <= 2042) {
    const ch = String.fromCharCode(97 + k - 2017);
    return shift ? ch.toUpperCase() : ch;
  }
  if (k >= 2000 && k <= 2009 && !shift) return String(k - 2000);
  return shift ? undefined : PUNCTUATION[k];
}

/** A keystroke as a `keyEvent` key: a name `input --key` knows, a KeyCode id, or a `+` combo. Pure. */
export function keystrokeName(codes: readonly number[]): string {
  return codes.map((c) => KEY_NAMES[c] ?? String(c)).join('+');
}

// uitest's pointer OP_TYPEs and the step each becomes (back and home are handled as keys).
const POINTER_ACTIONS: Readonly<Record<string, FlowStep['action']>> = {
  click: 'click',
  longClick: 'longClick',
  doubleClick: 'doubleClick',
  swipe: 'swipe',
  fling: 'swipe',
  drag: 'swipe',
};
// Pointer ops the recorder derives from keys or system gestures.
const NAVIGATION_OPS = new Set(['back', 'home', 'recent']);

// How long after a touch-down a layout dump is taken to show its effect.
const SETTLE_MS = 200;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function point(x: unknown, y: unknown, display: DisplaySize): FlowPoint | undefined {
  const px = Number(x);
  const py = Number(y);
  if (x === undefined || x === '' || y === undefined || y === '' || !Number.isFinite(px) || !Number.isFinite(py)) return undefined;
  return { fx: round3(clamp01(px / display.width)), fy: round3(clamp01(py / display.height)) };
}

/** Ids of the soft-keyboard windows in any of the layouts. */
function keyboardWindowIds(layouts: Array<LayoutNode | undefined>, imeBundles: readonly string[]): Set<number> {
  const ids = new Set<number>();
  for (const tree of layouts) {
    if (!tree) continue;
    const kb = findKeyboardWindow(tree, imeBundles);
    if (kb?.windowId !== undefined) ids.add(kb.windowId);
    if (kb?.bundle) for (const w of listLayoutWindows(tree)) if (w.bundle === kb.bundle) ids.add(w.windowId);
  }
  return ids;
}

const contains = (n: FlatLayoutNode, p: FlowPoint): boolean =>
  !!n.b && p.fx >= n.b[0] && p.fx <= n.b[2] && p.fy >= n.b[1] && p.fy <= n.b[3];

/**
 * The element a touch at `p` lands on in a pruned layout: the last element in
 * paint order whose bounds contain the point and that is not covered, skipping
 * window roots and bare containers. Pure.
 */
export function elementAt(tree: LayoutNode, p: FlowPoint): FlatLayoutNode | undefined {
  let hit: FlatLayoutNode | undefined;
  for (const n of flattenLayout(tree)) {
    if (n.type === 'root' || n.bundle !== undefined || n.covered || n.hidden || !contains(n, p)) continue;
    if (!(n.text || n.desc || n.hint || n.id || n.key || n.click || n.longClick || n.scroll || n.type)) continue;
    hit = n;
  }
  return hit;
}

/** The recorded widget, if `tree` has it under the touch point; else what the touch lands on there. */
function touchedElement(tree: LayoutNode, p: FlowPoint, finger: UiRecordFinger): FlatLayoutNode | undefined {
  const fields: Array<[keyof FlatLayoutNode, string | undefined]> = [
    ['type', finger.W1_Type || undefined],
    ['id', finger.W1_ID || undefined],
    ['text', finger.W1_Text || undefined],
  ];
  const given = fields.filter(([, v]) => v !== undefined);
  if (given.length > 0) {
    const same = flattenLayout(tree).filter((n) => !n.covered && contains(n, p) && given.every(([k, v]) => n[k] === v));
    if (same.length > 0) return same[same.length - 1];
  }
  return elementAt(tree, p);
}

/** {@link selectorFor} for a node of `tree`, or undefined when it has nothing to select it by. */
function selectorOf(tree: LayoutNode, node: FlatLayoutNode): string | undefined {
  try {
    return selectorFor(tree, node as RecordedElement);
  } catch {
    return undefined;
  }
}

const EDITABLE = /text|search|input/i;

/** The focused text field (outside the keyboard), if the layout shows one. */
function focusedField(tree: LayoutNode | undefined, keyboardIds: ReadonlySet<number>): FlatLayoutNode | undefined {
  if (!tree) return undefined;
  const focused = flattenLayout(tree).filter(
    (n) => n.focus && !(n.windowId !== undefined && keyboardIds.has(n.windowId)) && n.type !== undefined && EDITABLE.test(n.type),
  );
  return focused[focused.length - 1];
}

const sameBox = (a: FlatLayoutNode, b: FlatLayoutNode): boolean => JSON.stringify(a.b) === JSON.stringify(b.b);

/**
 * A selector for a text field that does not depend on its content (which typing
 * changes): its type with its id, key or placeholder, else every one of them
 * plus the field's `[n]` index. Pure.
 */
export function fieldSelector(tree: LayoutNode, field: FlatLayoutNode): string | undefined {
  const typeClause: SelectorClause[] = field.type ? [{ key: 'type', op: '=', value: field.type }] : [];
  const stable: SelectorClause[] = [];
  for (const key of ['id', 'key', 'hint'] as const) {
    const value = key === 'key' ? field.key : selectorAttribute(field, key);
    if (value) stable.push({ key, op: '=', value });
  }
  for (const c of stable) {
    const text = formatSelector([...typeClause, c]);
    if (matchSelector(tree, parseSelector(text)).length === 1) return text;
  }
  const all = [...typeClause, ...stable];
  if (all.length === 0) return undefined;
  const matches = matchSelector(tree, parseSelector(formatSelector(all)));
  const i = matches.findIndex((m) => sameBox(m, field));
  if (i < 0) return undefined;
  return formatSelector(all, matches.length > 1 ? i : undefined);
}

/** The same field in another layout: same type, id, key and hint, nearest center. */
function sameField(tree: LayoutNode | undefined, field: FlatLayoutNode): FlatLayoutNode | undefined {
  if (!tree) return undefined;
  const same = flattenLayout(tree).filter(
    (n) => n.type === field.type && n.id === field.id && n.key === field.key && n.hint === field.hint,
  );
  if (!field.c || same.length <= 1) return same[0];
  const [x, y] = field.c;
  const d = (n: FlatLayoutNode): number => (n.c ? (n.c[0] - x) ** 2 + (n.c[1] - y) ** 2 : Infinity);
  return same.reduce((a, b) => (d(b) < d(a) ? b : a));
}

/**
 * A selector for an element that appeared with the step: unique and uncovered in
 * `after`, absent from `before`, inside the app's window. Ids and keys are tried
 * before texts. Undefined when nothing new is identifiable (the step did not
 * visibly change the app). Pure.
 */
export function expectFor(
  before: LayoutNode,
  after: LayoutNode,
  opts: { bundle?: string; keyboardIds?: ReadonlySet<number> } = {},
): string | undefined {
  if (before === after) return undefined;
  const nodes = flattenLayout(after).filter(
    (n) =>
      n.c &&
      !n.covered &&
      !n.hidden &&
      (opts.bundle === undefined || n.window === opts.bundle) &&
      !(n.windowId !== undefined && opts.keyboardIds?.has(n.windowId)),
  );
  const passes: SelectorKey[][] = [['id', 'key'], ['text', 'desc']];
  for (const keys of passes) {
    for (const n of nodes) {
      for (const key of keys) {
        if (key === 'key' && n.key === undefined) continue;
        const value = selectorAttribute(n, key);
        if (!value) continue;
        const clauses: SelectorClause[] = [];
        if (n.type) clauses.push({ key: 'type', op: '=', value: n.type });
        clauses.push({ key, op: '=', value });
        const text = formatSelector(clauses);
        const sel = parseSelector(text);
        if (matchSelector(after, sel).filter((m) => !m.covered).length !== 1) continue;
        if (matchSelector(before, sel).length > 0) continue;
        return text;
      }
    }
  }
  return undefined;
}

/** When things happened during the recording, read off the device (epoch ms). */
export interface RecordingTimes {
  /** When the `initial` layout was dumped. */
  initial: number;
  /** Every touch-down during the recording, in order (hilog `ServerMsgHandler: [P:D:…]`). */
  touchDowns: readonly number[];
  /** When uitest wrote each layout file (its mtime), by device path. */
  layouts: ReadonlyMap<string, number>;
}

/**
 * The touch-down time of each pointer event, by event index, when the events
 * account for exactly the touch-downs seen: one per finger (two for a
 * doubleClick), and none or one for back/home/recent (which uitest also reports
 * for keys). Undefined when neither count matches. Pure.
 */
export function alignTouches(events: readonly UiRecordEvent[], touchDowns: readonly number[]): Map<number, number> | undefined {
  for (const navigationDowns of [0, 1]) {
    const need = events.map((ev) => {
      if (ev.OP_TYPE === 'key') return 0;
      if (NAVIGATION_OPS.has(ev.OP_TYPE)) return navigationDowns;
      const fingers = Math.max(1, Number(ev.fingerNumber ?? '1') || 1);
      return ev.OP_TYPE === 'doubleClick' ? 2 * fingers : fingers;
    });
    if (need.reduce((a, b) => a + b, 0) !== touchDowns.length) continue;
    const times = new Map<number, number>();
    let cursor = 0;
    need.forEach((n, i) => {
      if (n > 0) times.set(i, touchDowns[cursor]!);
      cursor += n;
    });
    return times;
  }
  return undefined;
}

export interface FlowFromRecordingInput {
  events: readonly UiRecordEvent[];
  /** The pruned layouts the recorder saved, by the device path in each event's `FILEPAHT`. */
  layouts: ReadonlyMap<string, LayoutNode>;
  /** A pruned layout dumped just before recording started. */
  initial: LayoutNode;
  /** A pruned layout dumped just after recording stopped (the state after the last event). */
  final?: LayoutNode;
  /** When the touches and the layouts happened; without it the layouts are taken in event order. */
  times?: RecordingTimes;
  display: DisplaySize;
  /** Input-method bundles (see `getImeBundles`), to tell taps on the soft keyboard apart. */
  imeBundles?: readonly string[];
  /** The app being recorded; default: the first bundle the pointer events name. */
  bundle?: string;
  ability?: string;
  api?: number;
}

export interface FlowFromRecordingResult {
  flow: Flow;
  /** Events that could not be turned into steps, steps left without a selector, timing problems. */
  warnings: string[];
}

interface Scene {
  /** The screen when the event happened. */
  before: LayoutNode;
  /** The screen once the event took effect, before the next one; undefined when no layout shows it. */
  after?: LayoutNode;
}

/**
 * Pick, for every event, the layout on screen when it happened and the one after
 * it. uitest writes an event (and dumps its layout, and hit-tests its widget)
 * only once the next touch has started, so with a quick next action its layout
 * and widget already show the next screen. With `times`, the layouts are placed
 * on the device clock instead: an event's screen is the last layout written
 * before its touch-down, and its result the last one written before the next
 * touch-down. Without `times`, each event's screen is the previous event's layout.
 */
function scenes(input: FlowFromRecordingInput, warnings: string[]): Scene[] {
  const { events } = input;
  const touch = input.times ? alignTouches(events, input.times.touchDowns) : undefined;
  if (input.times && !touch) {
    warnings.push(
      `the recorder's ${events.filter((e) => e.OP_TYPE !== 'key').length} pointer events do not match the ` +
        `${input.times.touchDowns.length} touch-downs in hilog, so each event is matched to the layout uitest saved ` +
        'before it, which shows the wrong screen when the next action followed within about 3 s; check the selectors',
    );
  }
  if (touch && input.times) {
    const timeline = [{ t: input.times.initial, tree: input.initial }];
    for (const [file, tree] of input.layouts) {
      const t = input.times.layouts.get(file);
      if (t !== undefined) timeline.push({ t, tree });
    }
    timeline.sort((a, b) => a.t - b.t);
    const at = (t: number): LayoutNode => {
      let tree = input.initial;
      for (const s of timeline) if (s.t < t) tree = s.tree;
      return tree;
    };
    const nextTouch = (i: number): number | undefined => {
      for (let j = i + 1; j < events.length; j++) if (touch.has(j)) return touch.get(j);
      return undefined;
    };
    const out: Scene[] = [];
    let previousAfter: LayoutNode = input.initial;
    events.forEach((_ev, i) => {
      const t = touch.get(i);
      const next = nextTouch(i);
      const before = t !== undefined ? at(t) : previousAfter;
      let after: LayoutNode | undefined;
      if (next !== undefined) after = at(next);
      else if (i < events.length - 1 && t !== undefined) {
        // Keys follow the last touch and have no time: take the first layout written once the touch took effect.
        after = timeline.find((s) => s.t > t + SETTLE_MS)?.tree;
      }
      after ??= input.final ?? timeline[timeline.length - 1]!.tree;
      if (after === before) after = undefined;
      out.push({ before, ...(after ? { after } : {}) });
      previousAfter = after ?? before;
    });
    return out;
  }
  let before = input.initial;
  return events.map((ev, i) => {
    const own = ev.FILEPAHT ? input.layouts.get(ev.FILEPAHT) : undefined;
    const after = own ?? (i === events.length - 1 ? input.final : undefined);
    const scene: Scene = { before, ...(after ? { after } : {}) };
    if (own) before = own;
    return scene;
  });
}

interface TextRun {
  first: Scene;
  last: Scene;
  /** What was typed, `\b` for a backspace, undefined for a key with no character (shift, a symbol pane). */
  typed: Array<string | undefined>;
}

/**
 * Turn the events of a `uitest uiRecord record -l` session into a flow. Each
 * pointer event becomes a step on the element under its touch point in the
 * layout on screen at that moment (uitest's own widget when that layout has it
 * there, since uitest hit-tests late), with {@link selectorFor}'s selector, the
 * touch point as `fallback`, and as `expect` an element that appeared after it
 * ({@link expectFor}). Taps on the soft keyboard and typed keystrokes collapse
 * into one inputText step on the focused field ({@link fieldSelector}), with the
 * text read off that field afterwards; other keys, and back and home, become
 * keyEvent steps. A tap on a field next to the inputText step for that field is
 * dropped (inputText taps it). Pure.
 */
export function flowFromRecording(input: FlowFromRecordingInput): FlowFromRecordingResult {
  const { display, events } = input;
  const imeBundles = input.imeBundles ?? [];
  const warnings: string[] = [];
  const steps: FlowStep[] = [];
  const scene = scenes(input, warnings);
  let bundle = input.bundle;
  let ability = input.ability;
  let run: TextRun | null = null;
  let stroke: { codes: number[]; scene: Scene } | null = null;

  const withExpect = (step: FlowStep, s: Scene): FlowStep => {
    if (!s.after) return step;
    const expect = expectFor(s.before, s.after, { bundle, keyboardIds: keyboardWindowIds([s.before, s.after], imeBundles) });
    if (expect) step.expect = expect;
    return step;
  };

  const flushRun = (): void => {
    if (!run) return;
    const r: TextRun = run;
    run = null;
    const before = r.first.before;
    const after = r.last.after ?? r.last.before;
    const kbIds = keyboardWindowIds([before, after], imeBundles);
    const field = focusedField(after, kbIds) ?? focusedField(before, kbIds);
    let typed = '';
    for (const ch of r.typed) {
      if (ch === '\b') typed = typed.slice(0, -1);
      else if (ch !== undefined) typed += ch;
    }
    const step: FlowStep = { action: 'inputText', text: typed };
    if (field) {
      const prior = sameField(before, field);
      const now = sameField(after, field) ?? field;
      const sel = prior ? fieldSelector(before, prior) : fieldSelector(after, now);
      if (sel) step.selector = sel;
      // The field's own text afterwards is what was typed, shift, symbols and corrections included.
      if (now.text) {
        step.text = now.text;
        if (prior?.text && prior.text !== now.text) step.clear = true;
      }
    }
    if (!step.selector) warnings.push(`step ${steps.length}: typed text without a field to select; it types into the focused field`);
    steps.push(step);
  };

  const addKeystroke = (codes: number[], s: Scene): void => {
    const ch = keystrokeChar(codes);
    const isBackspace = codes.length === 1 && codes[0] === KEY_BACKSPACE;
    if (ch !== undefined || (isBackspace && run)) {
      run ??= { first: s, last: s, typed: [] };
      run.typed.push(isBackspace ? '\b' : ch);
      run.last = s;
      return;
    }
    flushRun();
    steps.push(withExpect({ action: 'keyEvent', key: keystrokeName(codes) }, s));
  };

  events.forEach((ev, i) => {
    const s = scene[i]!;
    if (ev.OP_TYPE === 'key') {
      const codes = [ev.KeyCode1, ev.KeyCode2, ev.KeyCode3].filter((c): c is string => !!c).map(Number);
      if (!ev.FILEPAHT) {
        // The first line of a keystroke (with its modifiers); the second, with the layout, closes it.
        if (stroke) addKeystroke(stroke.codes, stroke.scene);
        stroke = { codes, scene: s };
      } else {
        addKeystroke(stroke?.codes ?? codes, { before: stroke?.scene.before ?? s.before, ...(s.after ? { after: s.after } : {}) });
        stroke = null;
      }
      return;
    }

    if (!bundle && ev.BUNDLE && !/^SCB/.test(ev.BUNDLE)) bundle = ev.BUNDLE;
    if (!ability && ev.ABILITY && ev.BUNDLE === bundle) ability = ev.ABILITY;
    const op = ev.OP_TYPE;

    if (op === 'back' || op === 'home') {
      flushRun();
      steps.push(withExpect({ action: 'keyEvent', key: op === 'back' ? 'Back' : 'Home' }, s));
      return;
    }

    const finger = ev.fingerList?.[0];
    const action = POINTER_ACTIONS[op];
    if (!finger || !action) {
      warnings.push(`skipped a "${op}" event: no step type for it`);
      return;
    }
    if (Number(ev.fingerNumber ?? '1') > 1) {
      warnings.push(`skipped a ${ev.fingerNumber}-finger "${op}": flows replay one finger`);
      return;
    }
    const at = point(finger.X_POSI, finger.Y_POSI, display);
    if (!at) {
      warnings.push(`skipped a "${op}" event: no touch point`);
      return;
    }

    const kbIds = keyboardWindowIds([s.before], imeBundles);
    const node = touchedElement(s.before, at, finger);
    if (action === 'click' && node?.windowId !== undefined && kbIds.has(node.windowId)) {
      // A tap on the soft keyboard: part of typing into the focused field.
      const label = [node.text, finger.W1_Text].find((t) => t !== undefined && [...t].length === 1);
      run ??= { first: s, last: s, typed: [] };
      run.typed.push(label);
      run.last = s;
      return;
    }
    flushRun();

    const step: FlowStep = { action };
    const sel = node ? selectorOf(s.before, node) : undefined;
    if (sel) step.selector = sel;
    step.fallback = at;
    if (action === 'swipe') {
      const to = point(finger.X2_POSI, finger.Y2_POSI, display);
      if (!to) {
        warnings.push(`skipped a "${op}" event: no end point`);
        return;
      }
      step.to = to;
    }
    if (!step.selector) {
      warnings.push(`step ${steps.length}: no element to select at ${at.fx},${at.fy}; it replays at that point`);
    }
    steps.push(withExpect(step, s));
  });
  if (stroke) addKeystroke((stroke as { codes: number[]; scene: Scene }).codes, (stroke as { scene: Scene }).scene);
  flushRun();

  const flow: Flow = {
    version: FLOW_VERSION,
    ...(bundle ? { bundle } : {}),
    ...(ability ? { ability } : {}),
    device: { ...(input.api !== undefined ? { api: input.api } : {}), display: { width: display.width, height: display.height } },
    steps: dropFocusTaps(steps),
  };
  return { flow, warnings };
}

/** Drop a click on a field next to the inputText step for the same field: replay's inputText taps it first. */
function dropFocusTaps(steps: FlowStep[]): FlowStep[] {
  return steps.filter((s, i) => {
    if (s.action !== 'click' || !s.selector) return true;
    const near = [steps[i - 1], steps[i + 1]];
    return !near.some((n) => n?.action === 'inputText' && n.selector !== undefined && sameTarget(n.selector, s.selector!));
  });
}

/** Two selectors for the same field: equal, or one of them adds only a text clause (a field tapped while it had text). */
function sameTarget(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (s: string): string => s.replace(/,text=("(?:[^"\\]|\\.)*"|[^,[]*)/, '');
  return strip(a) === strip(b);
}
