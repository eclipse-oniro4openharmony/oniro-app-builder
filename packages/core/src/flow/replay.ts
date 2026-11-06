import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { selectDevice } from '../hdc/devices.js';
import {
  describeLayoutNode,
  dumpLayout,
  findVisibleMatch,
  flattenLayout,
  listLayoutWindows,
  TargetNotFoundError,
  type DumpLayoutResult,
  type FlatLayoutNode,
} from '../hdc/dump.js';
import { clauseMatches, parseSelector, type ElementSelector } from '../hdc/selector.js';
import { performInput, selectableTree, waitForTargetLayout, type PerformInputOptions } from '../hdc/uiActions.js';
import { takeScreenshot } from '../hdc/screen.js';
import { forceStop, launchApp } from '../hdc/app.js';
import { holdScreenOn, isLockScreenShown, wakeAndUnlock } from '../hdc/power.js';
import type { Flow, FlowStep } from './flowFile.js';

/** Why a replay stopped at a step. */
export type DivergenceReason =
  /** The step's element did not appear within the timeout. */
  | 'not-found'
  /** The step ran, but its `expect` element did not appear. */
  | 'expect-not-found'
  /** The flow's app is not on screen (it crashed, another app or the lock screen is in front). */
  | 'wrong-screen'
  /** Several elements match the step's selector (append `[n]` or make it more specific). */
  | 'ambiguous'
  /** The element is there but covered by an overlay. */
  | 'covered'
  /** The input could not be sent. */
  | 'action-failed';

export interface ReplayStepResult {
  index: number;
  action: FlowStep['action'];
  selector?: string;
  ok: boolean;
  durationMs: number;
  /** The element the step acted on. */
  target?: string;
  /** The step acted on its fallback point (no selector, or `fallback: true` and the selector was not found). */
  usedFallback?: boolean;
  /** This step's screenshot (`screenshotsDir`). */
  screenshot?: string;
}

/** What was on screen when the flow diverged. */
export interface DivergenceLayout {
  /** Windows on screen, in paint order. */
  windows: Array<{ windowId: number; bundle?: string }>;
  /** The flow's app has a window on screen. */
  appOnScreen?: boolean;
  lockScreen: boolean;
  keyboard: boolean;
  /** The app's elements (or, when it is not on screen, every element), one line each, capped. */
  elements: string[];
  /** How many elements there were before the cap. */
  elementCount: number;
}

/** An element that matches all but one clause of the step's selector. */
export interface NearMatch {
  element: string;
  /** The clause it fails, e.g. `text=Continue`. */
  differs: string;
}

export interface ReplayReport {
  ok: boolean;
  /** passed: every step ran; diverged: a step failed (exit 1); error: the replay could not run (exit 2). */
  outcome: 'passed' | 'diverged' | 'error';
  bundle?: string;
  /** Steps run (first index, last index), 0-based and inclusive. */
  range: [number, number];
  steps: ReplayStepResult[];
  failedStep?: number;
  reason?: DivergenceReason;
  message?: string;
  /** The selector that was not satisfied (the step's, or its expect). */
  selector?: string;
  /** Screenshot taken when the flow diverged. */
  screenshot?: string;
  layout?: DivergenceLayout;
  nearMatches?: NearMatch[];
  /** Why the replay could not run (outcome error). */
  error?: string;
  warnings: string[];
}

export interface ReplayFlowOptions {
  config: ConfigProvider;
  flow: Flow;
  deviceSerial?: string;
  logger?: Logger;
  /** First step to run, 0-based. Default 0. */
  from?: number;
  /** Last step to run, 0-based and inclusive. Default: the last step. */
  to?: number;
  /** How long to wait for a step's selector and its expect, ms. Default 10000. A step's `timeoutMs` overrides it. */
  stepTimeoutMs?: number;
  /** Poll interval of those waits, ms. Default 500. */
  pollMs?: number;
  /**
   * A layout dumped within this many ms after an action (or the launch) may show a screen
   * still in transition, so before a step acts on an element found in such a dump the
   * screen is dumped again and the element must be the same node at the same place.
   * Default 1500; 0 trusts every dump.
   */
  settleMs?: number;
  /** Save a screenshot after every step here (`step-<i>.jpeg`); the divergence screenshot goes here too. */
  screenshotsDir?: string;
  /** Act on a step's fallback point when its selector is not found, instead of diverging. */
  fallback?: boolean;
  /** Force-stop and start the flow's app before the first step. */
  launch?: boolean;
  /** Turn the screen on, swipe away a lock screen without a credential, keep it on during the run. Default true. */
  wake?: boolean;
  /** Take a screenshot when the flow diverges. Default true. */
  divergenceScreenshot?: boolean;
  onStep?: (result: ReplayStepResult) => void;
  abortSignal?: AbortSignal;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Divergence extends Error {
  constructor(
    readonly reason: DivergenceReason,
    message: string,
    readonly selector?: string,
  ) {
    super(message);
  }
}

const MAX_ELEMENTS = 40;

interface TimedLayout {
  layout: DumpLayoutResult;
  at: number;
}

/** The same element in two dumps: type, id, text and bounds agree. */
function sameNode(a: FlatLayoutNode, b: FlatLayoutNode): boolean {
  return a.type === b.type && a.id === b.id && a.text === b.text && JSON.stringify(a.b) === JSON.stringify(b.b);
}

/** Elements matching every clause of a DSL selector but one, for the divergence report. Pure. */
export function nearMatches(tree: DumpLayoutResult['tree'], selector: ElementSelector, limit = 5): NearMatch[] {
  if (selector.kind !== 'dsl' || selector.clauses.length < 2) return [];
  const out: NearMatch[] = [];
  for (const n of flattenLayout(tree)) {
    const failed = selector.clauses.filter((c) => !clauseMatches(n, c));
    if (failed.length !== 1) continue;
    const c = failed[0]!;
    out.push({ element: describeLayoutNode(n), differs: `${c.key}${c.op}${c.value}` });
    if (out.length >= limit) break;
  }
  return out;
}

/** What is on screen, focused on the flow's app. Pure. */
export function summarizeDivergenceLayout(layout: DumpLayoutResult, bundle?: string): DivergenceLayout {
  const windows = listLayoutWindows(layout.tree).map((w) => ({ windowId: w.windowId, ...(w.bundle ? { bundle: w.bundle } : {}) }));
  const all = flattenLayout(selectableTree(layout));
  const appOnScreen = bundle ? all.some((n) => n.window === bundle) : undefined;
  const shown: FlatLayoutNode[] = appOnScreen ? all.filter((n) => n.window === bundle) : all;
  const labelled = shown.filter((n) => n.c && (n.text || n.desc || n.hint || n.id || n.click));
  return {
    windows,
    ...(appOnScreen !== undefined ? { appOnScreen } : {}),
    lockScreen: isLockScreenShown(layout.tree),
    keyboard: !!layout.keyboard?.shown,
    elements: labelled.slice(0, MAX_ELEMENTS).map((n) => `${describeLayoutNode(n)}${n.covered ? ' (covered)' : ''}`),
    elementCount: labelled.length,
  };
}

function stepInput(step: FlowStep): Omit<PerformInputOptions, 'config' | 'deviceSerial' | 'logger'> {
  switch (step.action) {
    case 'swipe':
      return { type: 'swipe', fx2: step.to?.fx, fy2: step.to?.fy, speed: step.speed };
    case 'inputText':
      return { type: 'inputText', text: step.text, clear: step.clear };
    case 'keyEvent':
      return { type: 'keyEvent', key: step.key };
    default:
      return { type: step.action as 'click' };
  }
}

/**
 * Replay a flow on the device through the same path as `input --selector` and
 * `wait --selector`: for each step, wait for its selector, act on the element
 * (or on its fallback point), pause `waitMs`, then wait for its `expect`. Stops
 * at the first step that fails and reports why (see {@link DivergenceReason}),
 * with a screenshot, a summary of what was on screen, and the elements that
 * nearly match the selector. Never throws for a divergence or a missing device:
 * the report's outcome says which.
 */
export async function replayFlow(opts: ReplayFlowOptions): Promise<ReplayReport> {
  const { config, flow } = opts;
  const logger = opts.logger ?? noopLogger;
  const from = opts.from ?? 0;
  const to = opts.to ?? flow.steps.length - 1;
  const report: ReplayReport = { ok: false, outcome: 'error', bundle: flow.bundle, range: [from, to], steps: [], warnings: [] };
  if (flow.steps.length === 0) {
    report.error = 'The flow has no steps.';
    return report;
  }
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to < flow.steps.length && from <= to)) {
    report.error = `Step range ${from}..${to} is outside the flow's steps 0..${flow.steps.length - 1}.`;
    return report;
  }
  const stepTimeoutMs = opts.stepTimeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 500;
  const settleMs = opts.settleMs ?? 1500;

  let deviceSerial: string;
  try {
    deviceSerial = await selectDevice(config, opts.deviceSerial, { logger });
  } catch (err) {
    report.error = (err as Error).message;
    return report;
  }
  const device = { config, deviceSerial, logger };

  let restoreScreen: (() => Promise<void>) | undefined;
  let index = from;
  let stepStarted = Date.now();
  // The last dump that shows the current screen: taken by a wait that succeeded and nothing
  // acted since. The next step's selector is looked up in it before the screen is dumped
  // again, and an action locates its target in it; a dump costs about a second on a phone.
  let seen: TimedLayout | undefined;
  let actedAt = Date.now();
  const tree = (l: DumpLayoutResult): DumpLayoutResult['tree'] => selectableTree(l) ?? { children: [] };
  try {
    if (opts.wake !== false) {
      const screen = await wakeAndUnlock(device);
      if (screen.locked) {
        report.error = 'The lock screen asks for a credential; unlock the device before replaying.';
        return report;
      }
      restoreScreen = await holdScreenOn({ ...device, ms: 1_800_000 });
    }
    if (opts.launch) {
      if (!flow.bundle) {
        report.error = 'The flow names no bundle to launch.';
        return report;
      }
      await forceStop({ ...device, bundle: flow.bundle }).catch(() => undefined);
      await launchApp({ ...device, bundleName: flow.bundle, abilityName: flow.ability });
      actedAt = Date.now();
    }

    for (index = from; index <= to; index++) {
      if (opts.abortSignal?.aborted) throw new CancelledError('Replay cancelled.');
      const step = flow.steps[index]!;
      stepStarted = Date.now();
      const result: ReplayStepResult = { index, action: step.action, ok: false, durationMs: 0 };
      if (step.selector) result.selector = step.selector;
      report.steps.push(result);
      const timeoutMs = step.timeoutMs ?? stepTimeoutMs;

      const selector = step.selector ? parseSelector(step.selector) : undefined;
      let useFallback = !selector;
      // The dump that shows the step's selector: the cached one when it does, else a wait's.
      let shows = selector && seen && !step.gone && findVisibleMatch(tree(seen.layout), selector) ? seen : undefined;
      if (selector && !shows) {
        seen = undefined;
        try {
          shows = seen = { layout: (await waitForTargetLayout({ ...device, selector, gone: step.gone, timeoutMs, pollMs, abortSignal: opts.abortSignal })).layout, at: Date.now() };
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          const pointed = step.action !== 'wait' && step.action !== 'keyEvent';
          if (!(opts.fallback && step.fallback && pointed && !step.gone)) {
            throw new Divergence(
              'not-found',
              step.gone
                ? `An element matching ${step.selector} was still on screen after ${timeoutMs} ms.`
                : `No element matching ${step.selector} appeared within ${timeoutMs} ms.`,
              step.selector,
            );
          }
          logger.warn(`step ${index}: ${step.selector} not found; acting on the recorded point`);
          useFallback = true;
        }
      }

      if (step.action !== 'wait') {
        // keyEvent and inputText without a selector act on whatever has focus; the selector only gates them.
        const targeted = step.action !== 'keyEvent' && !useFallback && selector;
        const at = useFallback && step.fallback && step.action !== 'keyEvent' ? { fx: step.fallback.fx, fy: step.fallback.fy } : {};
        // A dump taken while the screen may still be moving (within settleMs of the last action:
        // a page being popped still shows the old page's elements) is confirmed by a second one
        // before the step acts on it: the element must be the same node at the same place, else
        // the newer dump is the candidate, waited for again when the element is not in it.
        const settled = async (d: TimedLayout, sel: ElementSelector): Promise<DumpLayoutResult> => {
          let cur = d;
          while (cur.at - actedAt < settleMs && Date.now() - stepStarted < timeoutMs) {
            const fresh = await dumpLayout({ ...device, detectKeyboard: true }).catch(() => undefined); // a transient hdc failure: wait again below
            const again: TimedLayout | undefined = fresh ? { layout: fresh, at: Date.now() } : undefined;
            const a = findVisibleMatch(tree(cur.layout), sel);
            const b = again ? findVisibleMatch(tree(again.layout), sel) : null;
            if (again && a && b && sameNode(a, b)) return again.layout;
            if (again && b) { cur = again; continue; }
            try {
              cur = { layout: (await waitForTargetLayout({ ...device, selector: sel, timeoutMs, pollMs, abortSignal: opts.abortSignal })).layout, at: Date.now() };
            } catch (err) {
              if (err instanceof CancelledError) throw err;
              throw new Divergence('not-found', `An element matching ${step.selector} was on screen, then gone before the step could act on it.`, step.selector);
            }
          }
          return cur.layout;
        };
        const layout = targeted && shows ? await settled(shows, selector) : undefined;
        seen = undefined; // whatever the action does, the screen is no longer what the dump showed
        try {
          const done = await performInput({ ...device, ...stepInput(step), ...(targeted ? { target: selector, layout } : {}), ...at });
          actedAt = Date.now();
          if (done.target) result.target = describeLayoutNode(done.target);
        } catch (err) {
          if (err instanceof TargetNotFoundError) {
            const reason = err.reason === 'ambiguous' ? 'ambiguous' : err.reason === 'covered' ? 'covered' : 'not-found';
            throw new Divergence(reason, err.message, step.selector);
          }
          throw new Divergence('action-failed', (err as Error).message, step.selector);
        }
        if (useFallback && step.fallback && 'fx' in at) result.usedFallback = true;
      }

      if (step.waitMs) await sleep(step.waitMs);
      if (step.expect) {
        try {
          seen = { layout: (await waitForTargetLayout({ ...device, selector: parseSelector(step.expect), timeoutMs, pollMs, abortSignal: opts.abortSignal })).layout, at: Date.now() };
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          throw new Divergence(
            'expect-not-found',
            `The step ran, but no element matching ${step.expect} appeared within ${timeoutMs} ms.`,
            step.expect,
          );
        }
      }
      if (opts.screenshotsDir) {
        result.screenshot = await saveScreenshot(device, opts.screenshotsDir, `step-${String(index).padStart(2, '0')}.jpeg`).catch(
          (err: Error) => {
            report.warnings.push(`step ${index}: no screenshot: ${err.message}`);
            return undefined;
          },
        );
      }
      result.ok = true;
      result.durationMs = Date.now() - stepStarted;
      opts.onStep?.(result);
    }
    report.ok = true;
    report.outcome = 'passed';
    return report;
  } catch (err) {
    const last = report.steps[report.steps.length - 1];
    if (last && !last.ok) {
      last.durationMs = Date.now() - stepStarted;
      opts.onStep?.(last);
    }
    if (!(err instanceof Divergence)) {
      report.error = err instanceof OniroError || err instanceof Error ? err.message : String(err);
      if (last && !last.ok) report.failedStep = index;
      return report;
    }
    report.outcome = 'diverged';
    report.failedStep = index;
    report.reason = err.reason;
    report.message = err.message;
    if (err.selector) report.selector = err.selector;
    await describeDivergence(report, device, opts, err.selector);
    return report;
  } finally {
    await restoreScreen?.();
  }
}

/** Fill in the screen state of a divergence: layout summary, near matches, screenshot, wrong-screen detection. */
async function describeDivergence(
  report: ReplayReport,
  device: { config: ConfigProvider; deviceSerial: string; logger: Logger },
  opts: ReplayFlowOptions,
  selectorText: string | undefined,
): Promise<void> {
  try {
    const layout = await dumpLayout({ ...device, detectKeyboard: true });
    const summary = summarizeDivergenceLayout(layout, opts.flow.bundle);
    report.layout = summary;
    if (selectorText) {
      const near = nearMatches(selectableTree(layout), parseSelector(selectorText));
      if (near.length > 0) report.nearMatches = near;
    }
    if (summary.lockScreen || summary.appOnScreen === false) {
      report.reason = 'wrong-screen';
      const front = summary.lockScreen
        ? 'the lock screen is shown'
        : `${opts.flow.bundle} is not on screen (windows: ${summary.windows.map((w) => w.bundle ?? w.windowId).join(', ') || 'none'})`;
      report.message = `${front}. ${report.message ?? ''}`.trim();
    }
  } catch (err) {
    report.warnings.push(`could not dump the layout: ${(err as Error).message}`);
  }
  if (opts.divergenceScreenshot === false) return;
  const dir = opts.screenshotsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-replay-'));
  try {
    report.screenshot = await saveScreenshot(device, dir, `failed-step-${String(report.failedStep).padStart(2, '0')}.jpeg`);
  } catch (err) {
    report.warnings.push(`could not take a screenshot: ${(err as Error).message}`);
  }
}

async function saveScreenshot(
  device: { config: ConfigProvider; deviceSerial: string; logger: Logger },
  dir: string,
  name: string,
): Promise<string> {
  const shot = await takeScreenshot(device);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, name);
  fs.writeFileSync(file, shot.pixels);
  return file;
}
