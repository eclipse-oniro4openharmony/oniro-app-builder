import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import {
  assertLayoutSelector,
  dumpLayout,
  findVisibleMatch,
  pickTarget,
  withoutWindow,
  windowSubtree,
  TargetNotFoundError,
  type DumpLayoutResult,
  type ElementQuery,
  type FlatLayoutNode,
} from './dump.js';
import { getDisplaySize, type DisplaySize } from './display.js';
import { sendInput, type InputType } from './input.js';
import { waitForCondition } from './wait.js';

/** `uitest uiInput` actions plus the composite ones built on top of them. */
export type UiInputType = InputType | 'clearText' | 'hideKeyboard';

// Give a just-tapped field time to take focus (and the IME to attach) before typing.
const FOCUS_SETTLE_MS = 400;
// Let the layout reflow after the soft keyboard closes.
const KEYBOARD_SETTLE_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What selectors search (input, wait, screenshot and `dump layout --selector`):
 * the tree minus the soft-keyboard window, whose keys are not targets, unless
 * the caller restricted the dump to one window, which is then the one asked for.
 */
export function selectableTree(layout: DumpLayoutResult, windowId?: number): DumpLayoutResult['tree'] {
  const kb = layout.keyboard;
  return kb?.shown && kb.bundle && windowId === undefined ? withoutWindow(layout.tree, kb.bundle) : layout.tree;
}

/** A 0–1 fraction of a display dimension as a pixel inside it (1.0 maps to the last pixel). */
function fractionToPixel(f: number, size: number): number {
  return Math.min(size - 1, Math.round(f * size));
}

interface DeviceOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  logger?: Logger;
}

function pressBack(opts: DeviceOptions): Promise<void> {
  return sendInput({ config: opts.config, type: 'keyEvent', key: 'Back', deviceSerial: opts.deviceSerial, logger: opts.logger });
}

/**
 * Dismiss the soft keyboard with Back — only when it is actually on screen, since
 * Back without a keyboard navigates away. Returns whether a keyboard was dismissed.
 */
export async function hideKeyboard(opts: DeviceOptions): Promise<boolean> {
  const { keyboard } = await dumpLayout({ ...opts, detectKeyboard: true });
  if (!keyboard?.shown) return false;
  await pressBack(opts);
  await sleep(KEYBOARD_SETTLE_MS);
  return true;
}

export interface LocateTargetOptions extends DeviceOptions {
  /** `--target` fields, or a parsed `--selector` expression (see {@link parseSelector}). */
  selector: ElementQuery;
  /** Picks among several matching elements (see {@link pickTarget}). */
  index?: number;
  /** Only look in this window (see {@link DumpLayoutOptions.windowId}). */
  windowId?: number;
  /**
   * When the soft keyboard is up and the target is missing, covered, or matches
   * only a non-clickable label (the button may be hidden below the keyboard),
   * dismiss the keyboard and look again. Default true.
   */
  hideKeyboard?: boolean;
  /**
   * A layout dumped a moment ago (a wait that just found the element): the target is
   * looked up in it first, and a fresh dump is taken only when it is not there.
   */
  layout?: DumpLayoutResult;
}

export interface LocatedTarget {
  node: FlatLayoutNode;
  /** Center of the element in device pixels. */
  x: number;
  y: number;
  display: DisplaySize;
  /** The soft keyboard was dismissed to reach the element. */
  keyboardHidden: boolean;
}

/**
 * Resolve a selector against the live layout to one element and its pixel
 * center. Keys on the soft keyboard are not candidates.
 */
export async function locateTarget(opts: LocateTargetOptions): Promise<LocatedTarget> {
  assertLayoutSelector(opts.selector);
  const dumpOpts = {
    config: opts.config,
    detectKeyboard: true,
    windowId: opts.windowId,
    deviceSerial: opts.deviceSerial,
    logger: opts.logger,
  };
  let layout = opts.layout ?? (await dumpLayout(dumpOpts));
  // Without the display size no node has a position, and every match would look missing.
  if (!layout.display) throw new OniroError('Could not read the display size to locate the element.');
  let keyboardHidden = false;
  let node: FlatLayoutNode | undefined;
  let failure: unknown;
  const look = (): void => {
    try {
      node = pickTarget(selectableTree(layout, opts.windowId), opts.selector, opts.index);
      failure = undefined;
    } catch (err) {
      if (!(err instanceof TargetNotFoundError) || err.reason === 'ambiguous') throw err;
      failure = err;
      node = undefined;
    }
  };
  look();
  if (!node && opts.layout) {
    // Not in the dump the caller had: the screen may have moved on since; look at it now.
    layout = await dumpLayout(dumpOpts);
    if (!layout.display) throw new OniroError('Could not read the display size to locate the element.');
    look();
  }
  if ((!node || !node.click) && layout.keyboard?.shown && opts.hideKeyboard !== false) {
    opts.logger?.debug('target not reachable while the keyboard is up; dismissing it and looking again');
    await pressBack(opts);
    await sleep(KEYBOARD_SETTLE_MS);
    keyboardHidden = true;
    layout = await dumpLayout(dumpOpts);
    if (!layout.display) throw new OniroError('Could not read the display size to locate the element.');
    node = pickTarget(selectableTree(layout, opts.windowId), opts.selector, opts.index);
  }
  if (!node) throw failure;
  if (!node.c) throw new OniroError('The element has no on-screen position.');
  const x = fractionToPixel(node.c[0], layout.display.width);
  const y = fractionToPixel(node.c[1], layout.display.height);
  return { node, x, y, display: layout.display, keyboardHidden };
}

export interface PerformInputOptions extends DeviceOptions {
  type: UiInputType;
  /** Start point in device pixels. */
  pxX?: number;
  pxY?: number;
  /** End point in device pixels (swipe/drag/fling). */
  pxX2?: number;
  pxY2?: number;
  /** Start point as 0–1 fractions of the display. */
  fx?: number;
  fy?: number;
  /** End point as 0–1 fractions of the display. */
  fx2?: number;
  fy2?: number;
  /** Start point: the center of the element matching this selector (`--target` fields or a parsed `--selector`). */
  target?: ElementQuery;
  /** Picks among several elements matching `target`. */
  targetIndex?: number;
  /** Look for `target` only in this window. */
  windowId?: number;
  /** A layout dumped a moment ago to find `target` in first (see {@link LocateTargetOptions.layout}). */
  layout?: DumpLayoutResult;
  /** Velocity for swipe/drag/fling. */
  speed?: number;
  /** Key for keyEvent (see `resolveKeyEvent`). */
  key?: string | number;
  /** Text for inputText. */
  text?: string;
  /** inputText: clear the field before typing. */
  clear?: boolean;
  /** Dismiss the soft keyboard after the action, if it is up. */
  hideKeyboard?: boolean;
}

export interface PerformInputResult {
  /** Resolved start point in device pixels, when the action has one. */
  x?: number;
  y?: number;
  /** The element `target` resolved to. */
  target?: FlatLayoutNode;
  /** The soft keyboard was dismissed (to reach the target, or because it was asked to). */
  keyboardHidden: boolean;
}

function fraction(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!(value >= 0 && value <= 1)) throw new OniroError(`${name} must be a fraction between 0 and 1; got ${value}.`);
  return value;
}

function pair<T>(a: T | undefined, b: T | undefined, names: string): [T, T] | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined || b === undefined) throw new OniroError(`Give both ${names}.`);
  return [a, b];
}

/**
 * Perform a UI input action. Beyond the raw `uitest uiInput` primitives, this
 * resolves the start point from an element selector (`target`), 0–1 display
 * fractions, or pixels; clears text fields (Ctrl+A, Delete); and dismisses the
 * soft keyboard only when it is up.
 */
export async function performInput(opts: PerformInputOptions): Promise<PerformInputResult> {
  const device: DeviceOptions = { config: opts.config, deviceSerial: opts.deviceSerial, logger: opts.logger };
  const startFx = pair(fraction(opts.fx, '--fx'), fraction(opts.fy, '--fy'), '--fx and --fy');
  const startPx = pair(opts.pxX, opts.pxY, '--x and --y');
  const endFx = pair(fraction(opts.fx2, '--fx2'), fraction(opts.fy2, '--fy2'), '--fx2 and --fy2');
  const endPx = pair(opts.pxX2, opts.pxY2, '--x2 and --y2');
  if ([opts.target, startFx, startPx].filter((s) => s !== undefined).length > 1) {
    throw new OniroError('Give the start point one way: a target, fractions (--fx/--fy), or pixels (--x/--y).');
  }
  if (endFx && endPx) throw new OniroError('Give the end point one way: fractions (--fx2/--fy2) or pixels (--x2/--y2).');

  let display: DisplaySize | null | undefined;
  const toPx = async ([fx, fy]: [number, number]): Promise<[number, number]> => {
    display ??= await getDisplaySize(opts.config, { deviceSerial: opts.deviceSerial, logger: opts.logger });
    if (!display) throw new OniroError('Could not read the display size to convert fractions to pixels.');
    return [fractionToPixel(fx, display.width), fractionToPixel(fy, display.height)];
  };

  const result: PerformInputResult = { keyboardHidden: false };
  let start = startPx;
  if (opts.target) {
    const located = await locateTarget({ ...device, selector: opts.target, index: opts.targetIndex, windowId: opts.windowId, layout: opts.layout });
    display = located.display;
    start = [located.x, located.y];
    result.target = located.node;
    result.keyboardHidden = located.keyboardHidden;
  } else if (startFx) {
    start = await toPx(startFx);
  }
  const end = endFx ? await toPx(endFx) : endPx;
  if (start) [result.x, result.y] = start;

  const tapToFocus = async (): Promise<void> => {
    if (!start) return;
    await sendInput({ ...device, type: 'click', pxX: start[0], pxY: start[1] });
    await sleep(FOCUS_SETTLE_MS);
  };
  const clearFocused = async (): Promise<void> => {
    await sendInput({ ...device, type: 'keyEvent', key: 'Ctrl+A' });
    await sendInput({ ...device, type: 'keyEvent', key: 'Delete' });
  };

  switch (opts.type) {
    case 'hideKeyboard':
      result.keyboardHidden = (await hideKeyboard(device)) || result.keyboardHidden;
      return result;
    case 'clearText':
      await tapToFocus();
      await clearFocused();
      break;
    case 'inputText':
      if (opts.clear) {
        await tapToFocus();
        await clearFocused();
        await sendInput({ ...device, type: 'inputText', text: opts.text });
      } else {
        await sendInput({ ...device, type: 'inputText', pxX: start?.[0], pxY: start?.[1], text: opts.text });
      }
      break;
    default:
      await sendInput({
        ...device,
        type: opts.type,
        pxX: start?.[0],
        pxY: start?.[1],
        pxX2: end?.[0],
        pxY2: end?.[1],
        speed: opts.speed,
        key: opts.key,
        text: opts.text,
      });
  }

  if (opts.hideKeyboard) result.keyboardHidden = (await hideKeyboard(device)) || result.keyboardHidden;
  return result;
}

export interface WaitForTargetOptions extends DeviceOptions {
  /** `--target` fields, or a parsed `--selector` expression. */
  selector: ElementQuery;
  /** Only look in this window; while it is not on screen nothing matches. */
  windowId?: number;
  /** Wait until no uncovered element matches, instead of until one does. */
  gone?: boolean;
  timeoutMs: number;
  /** Poll interval. Default 500 (each poll is a full layout dump). */
  pollMs?: number;
  abortSignal?: AbortSignal;
}

/**
 * Poll the layout until an uncovered element matches `selector` (resolving with
 * it), or with `gone`, until none does (resolving null). Keys on the soft
 * keyboard are ignored. A DSL selector's `[n]` waits for that match. Throws on
 * timeout.
 */
export async function waitForTarget(opts: WaitForTargetOptions): Promise<FlatLayoutNode | null> {
  return (await waitForTargetLayout(opts)).node;
}

/**
 * {@link waitForTarget}, also returning the layout dump the condition was met in, so
 * that the caller can act on it (a replay locates the next step's target in it)
 * instead of dumping the same screen again.
 */
export async function waitForTargetLayout(opts: WaitForTargetOptions): Promise<{ node: FlatLayoutNode | null; layout: DumpLayoutResult }> {
  const { selector } = opts;
  assertLayoutSelector(selector);
  let found = null as FlatLayoutNode | null;
  let last: DumpLayoutResult | undefined;
  await waitForCondition({
    probe: async () => {
      const layout = await dumpLayout({
        config: opts.config,
        detectKeyboard: true,
        deviceSerial: opts.deviceSerial,
        logger: opts.logger,
      });
      last = layout;
      let tree: DumpLayoutResult['tree'] | null = layout.tree;
      if (opts.windowId !== undefined) tree = windowSubtree(layout.tree, opts.windowId);
      else tree = selectableTree(layout);
      found = tree ? findVisibleMatch(tree, selector) : null;
      return opts.gone ? found === null : found !== null;
    },
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs ?? 500,
    abortSignal: opts.abortSignal,
    logger: opts.logger,
    timeoutMessage: opts.gone
      ? `An element matching the selector was still on screen after ${opts.timeoutMs}ms.`
      : `No element matching the selector appeared within ${opts.timeoutMs}ms.`,
  });
  return { node: opts.gone ? null : found, layout: last! };
}
