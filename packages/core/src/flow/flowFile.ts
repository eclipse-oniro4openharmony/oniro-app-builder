import * as fs from 'node:fs';
import { OniroError } from '../ports/errors.js';
import { parseSelector } from '../hdc/selector.js';

/** The flow file format version this code reads and writes. */
export const FLOW_VERSION = 1;

/** What a step does. `wait` only waits for its selector (or, with `gone`, for it to disappear). */
export const FLOW_ACTIONS = ['click', 'longClick', 'doubleClick', 'swipe', 'inputText', 'keyEvent', 'wait'] as const;
export type FlowAction = (typeof FLOW_ACTIONS)[number];

/** A point as 0–1 fractions of the display, as `dump layout` prints centers. */
export interface FlowPoint {
  fx: number;
  fy: number;
}

/** One step of a flow. See packages/cli/README.md (`replay`) for the format. */
export interface FlowStep {
  action: FlowAction;
  /**
   * The element to wait for and act on, as `--selector` text (`type=Button,id=continueBtn`,
   * `xpath=//Button[@text="OK"]`). Optional for keyEvent (waited for, not tapped) and
   * inputText (types into the focused field); click-like actions and swipe need it or `fallback`.
   */
  selector?: string;
  /** Where to act when there is no selector (or, with `replay --fallback`, when it is not found). */
  fallback?: FlowPoint;
  /** inputText: the text to type. */
  text?: string;
  /** inputText: clear the field first. */
  clear?: boolean;
  /** keyEvent: a key name (Back, Home, Enter, Delete, …), a KeyCode id, or a combo like `Ctrl+A`. */
  key?: string | number;
  /** swipe: where the finger ends. */
  to?: FlowPoint;
  /** swipe: velocity, px/s (uitest default 600). */
  speed?: number;
  /** wait: wait until no element matches the selector, instead of until one does. */
  gone?: boolean;
  /** A selector for an element that must be on screen after the step. */
  expect?: string;
  /** Pause after the action, before `expect` and the next step, ms. */
  waitMs?: number;
  /** This step's timeout for its selector and `expect`, ms (default: `replay --step-timeout`). */
  timeoutMs?: number;
  /** Free text for people reading the flow; ignored. */
  note?: string;
}

/** The device a flow was recorded or written for (informational). */
export interface FlowDevice {
  api?: number;
  display?: { width: number; height: number };
}

/** A flow file: versioned JSON, written by `record` or by hand, run by `replay`. */
export interface Flow {
  version: typeof FLOW_VERSION;
  /** The app the flow drives; replay reports a divergence as `wrong-screen` when it is not on screen. */
  bundle?: string;
  /** The ability `replay --launch` starts (default: the bundle's main ability). */
  ability?: string;
  device?: FlowDevice;
  steps: FlowStep[];
}

/** A flow file that is not valid JSON or does not follow the format; lists every problem. */
export class FlowFormatError extends OniroError {
  constructor(
    readonly problems: string[],
    readonly file?: string,
  ) {
    super(`${file ? `${file}: ` : ''}not a valid flow:\n  ${problems.join('\n  ')}`);
    this.name = 'FlowFormatError';
  }
}

const STEP_KEYS = new Set([
  'action', 'selector', 'fallback', 'text', 'clear', 'key', 'to', 'speed', 'gone', 'expect', 'waitMs', 'timeoutMs', 'note',
]);
const FLOW_KEYS = new Set(['version', 'bundle', 'ability', 'device', 'steps']);
// Actions that land on a point: they need a selector or a fallback.
const POINTED: ReadonlySet<FlowAction> = new Set(['click', 'longClick', 'doubleClick', 'swipe']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkPoint(v: unknown, where: string, problems: string[]): void {
  if (!isObject(v)) {
    problems.push(`${where}: expected {"fx": <0-1>, "fy": <0-1>}`);
    return;
  }
  for (const k of ['fx', 'fy'] as const) {
    const n = v[k];
    if (typeof n !== 'number' || !(n >= 0 && n <= 1)) problems.push(`${where}.${k}: expected a fraction between 0 and 1`);
  }
  for (const k of Object.keys(v)) if (k !== 'fx' && k !== 'fy') problems.push(`${where}.${k}: unknown field`);
}

function checkSelector(v: unknown, where: string, problems: string[]): void {
  if (typeof v !== 'string' || v.trim() === '') {
    problems.push(`${where}: expected a selector string`);
    return;
  }
  try {
    parseSelector(v);
  } catch (err) {
    problems.push(`${where}: ${(err as Error).message}`);
  }
}

function checkMs(v: unknown, where: string, problems: string[]): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`${where}: expected a number of milliseconds >= 0`);
}

function checkStep(s: unknown, i: number, problems: string[]): void {
  const at = `steps[${i}]`;
  if (!isObject(s)) {
    problems.push(`${at}: expected an object`);
    return;
  }
  for (const k of Object.keys(s)) if (!STEP_KEYS.has(k)) problems.push(`${at}.${k}: unknown field`);
  const action = s.action as FlowAction;
  if (!(FLOW_ACTIONS as readonly string[]).includes(action as string)) {
    problems.push(`${at}.action: expected one of ${FLOW_ACTIONS.join(', ')}`);
    return;
  }
  if (s.selector !== undefined) checkSelector(s.selector, `${at}.selector`, problems);
  if (s.expect !== undefined) checkSelector(s.expect, `${at}.expect`, problems);
  if (s.fallback !== undefined) checkPoint(s.fallback, `${at}.fallback`, problems);
  if (s.to !== undefined) checkPoint(s.to, `${at}.to`, problems);
  if (s.waitMs !== undefined) checkMs(s.waitMs, `${at}.waitMs`, problems);
  if (s.timeoutMs !== undefined) checkMs(s.timeoutMs, `${at}.timeoutMs`, problems);
  if (s.note !== undefined && typeof s.note !== 'string') problems.push(`${at}.note: expected a string`);
  for (const k of ['clear', 'gone'] as const) {
    if (s[k] !== undefined && typeof s[k] !== 'boolean') problems.push(`${at}.${k}: expected true or false`);
  }
  if (s.speed !== undefined && !(typeof s.speed === 'number' && s.speed > 0)) problems.push(`${at}.speed: expected a positive number`);

  if (POINTED.has(action) && s.selector === undefined && s.fallback === undefined) {
    problems.push(`${at}: ${action} needs a selector or a fallback point`);
  }
  if (action === 'wait' && s.selector === undefined) problems.push(`${at}: wait needs a selector`);
  if (action === 'swipe' && s.to === undefined) problems.push(`${at}: swipe needs "to"`);
  if (action === 'inputText' && typeof s.text !== 'string') problems.push(`${at}.text: inputText needs the text to type`);
  if (action === 'keyEvent' && !(typeof s.key === 'string' ? s.key.trim() !== '' : typeof s.key === 'number')) {
    problems.push(`${at}.key: keyEvent needs a key (a name such as Back or Enter, a KeyCode id, or a combo like Ctrl+A)`);
  }
  const only: Array<[keyof FlowStep, FlowAction[]]> = [
    ['text', ['inputText']],
    ['clear', ['inputText']],
    ['key', ['keyEvent']],
    ['to', ['swipe']],
    ['speed', ['swipe']],
    ['gone', ['wait']],
  ];
  for (const [k, actions] of only) {
    if (s[k] !== undefined && !actions.includes(action)) problems.push(`${at}.${k}: only applies to ${actions.join(', ')}`);
  }
}

/**
 * Validate a parsed flow document, reporting every problem at once (field paths
 * such as `steps[2].selector`), and return it typed. Selectors are parsed, so a
 * flow that loads replays without a selector syntax error. Pure.
 */
export function parseFlow(doc: unknown, file?: string): Flow {
  const problems: string[] = [];
  if (!isObject(doc)) throw new FlowFormatError(['expected a JSON object with "version" and "steps"'], file);
  for (const k of Object.keys(doc)) if (!FLOW_KEYS.has(k)) problems.push(`${k}: unknown field`);
  if (doc.version !== FLOW_VERSION) problems.push(`version: expected ${FLOW_VERSION}, got ${JSON.stringify(doc.version)}`);
  if (doc.bundle !== undefined && typeof doc.bundle !== 'string') problems.push('bundle: expected a string');
  if (doc.ability !== undefined && typeof doc.ability !== 'string') problems.push('ability: expected a string');
  if (doc.device !== undefined && !isObject(doc.device)) problems.push('device: expected an object');
  if (!Array.isArray(doc.steps)) problems.push('steps: expected an array');
  else doc.steps.forEach((s, i) => checkStep(s, i, problems));
  if (problems.length > 0) throw new FlowFormatError(problems, file);
  return doc as unknown as Flow;
}

/** Read and validate a flow file. Throws {@link FlowFormatError}. */
export function readFlowFile(file: string): Flow {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new OniroError(`Could not read the flow file ${file}: ${(err as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new FlowFormatError([`not JSON: ${(err as Error).message}`], file);
  }
  return parseFlow(doc, file);
}

/** A flow as the JSON text `record` writes (two-space indent, trailing newline). */
export function formatFlow(flow: Flow): string {
  return `${JSON.stringify(flow, null, 2)}\n`;
}
