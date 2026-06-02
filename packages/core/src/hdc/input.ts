import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { shellChecked, ensureRemoteOk } from './exec.js';

export type InputType =
  | 'click'
  | 'doubleClick'
  | 'longClick'
  | 'swipe'
  | 'drag'
  | 'fling'
  | 'keyEvent'
  | 'inputText';

export interface SendInputOptions {
  config: ConfigProvider;
  type: InputType;
  /** Pixel coordinates. The %→px conversion lives in the MCP, not core. */
  pxX?: number;
  pxY?: number;
  pxX2?: number;
  pxY2?: number;
  /** Velocity for swipe/drag/fling. */
  speed?: number;
  /** Key id or symbolic name (Back/Home/Power) for keyEvent. */
  key?: string | number;
  /** Text for inputText. */
  text?: string;
  deviceSerial?: string;
  logger?: Logger;
}

function reqNum(value: number | undefined, name: string, type: string): number {
  if (value === undefined || Number.isNaN(value)) {
    throw new OniroError(`send input "${type}" requires a numeric ${name}.`);
  }
  return value;
}

/**
 * Build the `uitest uiInput …` command for an input action, in pixel space.
 * Pure (no I/O) so it is unit-testable. Mirrors the proven MCP construction
 * minus the percentage→pixel step.
 */
export function buildInputCommand(opts: SendInputOptions): string {
  switch (opts.type) {
    case 'click':
    case 'doubleClick':
    case 'longClick':
      return `uitest uiInput ${opts.type} ${reqNum(opts.pxX, 'pxX', opts.type)} ${reqNum(opts.pxY, 'pxY', opts.type)}`;
    case 'swipe':
    case 'drag':
    case 'fling': {
      const base =
        `uitest uiInput ${opts.type} ${reqNum(opts.pxX, 'pxX', opts.type)} ${reqNum(opts.pxY, 'pxY', opts.type)} ` +
        `${reqNum(opts.pxX2, 'pxX2', opts.type)} ${reqNum(opts.pxY2, 'pxY2', opts.type)}`;
      return opts.speed !== undefined ? `${base} ${opts.speed}` : base;
    }
    case 'keyEvent':
      if (opts.key === undefined || opts.key === '') throw new OniroError('send input "keyEvent" requires a key.');
      return `uitest uiInput keyEvent ${opts.key}`;
    case 'inputText': {
      const t = String(opts.text ?? '').replace(/'/g, `'\\''`);
      if (opts.pxX !== undefined && opts.pxY !== undefined) {
        return `uitest uiInput inputText ${opts.pxX} ${opts.pxY} '${t}'`;
      }
      return `uitest uiInput text '${t}'`;
    }
  }
}

/** Inject a UI input action via `uitest uiInput` (pixel coordinates). */
export async function sendInput(opts: SendInputOptions): Promise<void> {
  const cmd = buildInputCommand(opts);
  const res = await shellChecked({ config: opts.config, command: cmd, deviceSerial: opts.deviceSerial, timeoutMs: 30_000, logger: opts.logger });
  ensureRemoteOk(res, `hdc shell ${cmd}`);
}

export interface Waypoint {
  /** Pixel x. */
  x: number;
  /** Pixel y. */
  y: number;
  /** Time in ms relative to the gesture start. */
  t: number;
}

export interface SendGestureOptions {
  config: ConfigProvider;
  waypoints: Waypoint[];
  /** Hold at the first point before moving (ms). Honored via the raw-touch path. */
  holdStartMs?: number;
  /** Hold at the last point before lifting (ms). Honored via the raw-touch path. */
  holdEndMs?: number;
  deviceSerial?: string;
  logger?: Logger;
}

/**
 * Build the chained `uitest uiInput drag` commands for a multi-segment path.
 * Per segment, speed is derived from the waypoint time deltas (px/s). Pure.
 */
export function buildGestureCommands(waypoints: Waypoint[]): string[] {
  if (waypoints.length < 2) {
    throw new OniroError('sendGesture requires at least two waypoints.');
  }
  const cmds: string[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    const dt = b.t - a.t;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    let cmd = `uitest uiInput drag ${a.x} ${a.y} ${b.x} ${b.y}`;
    if (dt > 0 && dist > 0) cmd += ` ${Math.round(dist / (dt / 1000))}`;
    cmds.push(cmd);
  }
  return cmds;
}

export interface RawTouchEvent {
  type: 'down' | 'move' | 'up';
  x: number;
  y: number;
  /** Time in ms relative to the gesture start. */
  t: number;
}

export interface SendRawTouchOptions {
  config: ConfigProvider;
  events: RawTouchEvent[];
  deviceSerial?: string;
  logger?: Logger;
}

/**
 * Build a single `uinput -T` touch operation sequence from down/move/up events,
 * interleaving `-i <ms>` intervals from the event time deltas. Pure.
 */
export function buildRawTouchCommand(events: RawTouchEvent[]): string {
  if (events.length === 0) throw new OniroError('sendRawTouch requires at least one event.');
  const ops: string[] = [];
  let prev: RawTouchEvent | null = null;
  for (const ev of events) {
    if (prev && ev.t > prev.t) ops.push(`-i ${ev.t - prev.t}`);
    if (ev.type === 'down') ops.push(`-d ${ev.x} ${ev.y}`);
    else if (ev.type === 'up') ops.push(`-u ${ev.x} ${ev.y}`);
    else ops.push(`-m ${prev ? `${prev.x} ${prev.y} ` : ''}${ev.x} ${ev.y}`);
    prev = ev;
  }
  return `uinput -T ${ops.join(' ')}`;
}

/** Expand a waypoint path (+ optional holds) into raw down/move/up events for
 *  the `uinput` escape hatch ({@link sendRawTouch} / {@link buildRawTouchCommand}). */
export function waypointsToRawEvents(waypoints: Waypoint[], holdStartMs = 0, holdEndMs = 0): RawTouchEvent[] {
  if (waypoints.length < 2) throw new OniroError('sendGesture requires at least two waypoints.');
  const first = waypoints[0]!;
  const events: RawTouchEvent[] = [{ type: 'down', x: first.x, y: first.y, t: 0 }];
  for (let i = 1; i < waypoints.length; i++) {
    const w = waypoints[i]!;
    events.push({ type: 'move', x: w.x, y: w.y, t: w.t + holdStartMs });
  }
  const last = waypoints[waypoints.length - 1]!;
  events.push({ type: 'up', x: last.x, y: last.y, t: last.t + holdStartMs + holdEndMs });
  return events;
}

// `uitest uiInput swipe/drag` accepts a velocity in [200, 40000] px/s.
const UITEST_VELOCITY_MIN = 200;
const UITEST_VELOCITY_MAX = 40000;

export interface GestureUitestOptions {
  /** A leading press-hold; when > 0 the stroke uses `drag` (press-and-hold,
   *  then move) instead of `swipe`. uitest has no arbitrary hold duration. */
  holdStartMs?: number;
}

/**
 * Build a single continuous `uitest uiInput` stroke for a waypoint path. Pure.
 *
 * uitest has no polyline or stationary-hold primitive, so the path is collapsed
 * to first→last (gesture-nav strokes are straight lines) with the velocity
 * derived from the total elapsed time and clamped to uitest's range. A
 * requested `holdStartMs` maps to `drag` (which presses-and-holds before
 * moving — uitest's nearest equivalent to a leading hold); otherwise `swipe`.
 */
export function buildGestureUitestCommand(waypoints: Waypoint[], opts: GestureUitestOptions = {}): string {
  if (waypoints.length < 2) throw new OniroError('sendGesture requires at least two waypoints.');
  const a = waypoints[0]!;
  const b = waypoints[waypoints.length - 1]!;
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const dtMs = b.t - a.t;
  const op = (opts.holdStartMs ?? 0) > 0 ? 'drag' : 'swipe';
  let cmd = `uitest uiInput ${op} ${a.x} ${a.y} ${b.x} ${b.y}`;
  if (dtMs > 0 && dist > 0) {
    const v = Math.round(dist / (dtMs / 1000));
    cmd += ` ${Math.max(UITEST_VELOCITY_MIN, Math.min(UITEST_VELOCITY_MAX, v))}`;
  }
  return cmd;
}

/**
 * Drive a swipe-style gesture via a single continuous `uitest uiInput` stroke —
 * the MMI-injection path that `inputMonitor`-based services (gesture-nav,
 * systemui overlays) actually observe. Preferred over raw `uinput`, whose
 * kernel virtual-device events do not reach `inputMonitor` on some native-boot
 * devices (and whose multi-op form some on-device `uinput` builds reject).
 *
 * uitest has no polyline or stationary-hold primitive: a multi-waypoint path is
 * collapsed to first→last, `holdStartMs` maps to `drag` (press-hold-then-move),
 * and `holdEndMs` has no equivalent (ignored). For true press-time control use
 * {@link sendRawTouch} (raw `uinput`) — accepting the device caveats above.
 */
export async function sendGesture(opts: SendGestureOptions): Promise<void> {
  if ((opts.holdEndMs ?? 0) > 0) {
    opts.logger?.warn(
      'sendGesture: hold-end has no uitest equivalent and is ignored; use sendRawTouch for a trailing hold.',
    );
  }
  if (opts.waypoints.length > 2) {
    opts.logger?.debug(
      `sendGesture: ${opts.waypoints.length} waypoints collapsed to first→last (uitest has no polyline path).`,
    );
  }
  const cmd = buildGestureUitestCommand(opts.waypoints, { holdStartMs: opts.holdStartMs });
  const res = await shellChecked({ config: opts.config, command: cmd, deviceSerial: opts.deviceSerial, timeoutMs: 30_000, logger: opts.logger });
  ensureRemoteOk(res, `hdc shell ${cmd}`);
}

/**
 * Low-level touch injection via `uinput -T`. The escape hatch when press timing
 * matters (e.g. Quickstep motion-pause), which `uitest uiInput` can't express.
 *
 * WARNING: uinput's gesture form `uinput -T -g x1 y1 x2 y2 [press] [total]`
 * silently no-ops if `press < 500ms` or `total - press < 500ms` ("press time is
 * out of range" — it runs nothing). Keep press and post-press windows ≥ 500ms.
 *
 * DEVICE CAVEAT: on some native-boot devices these kernel-`uinput` events never
 * reach MMI `inputMonitor` services (gesture-nav, systemui), and some on-device
 * `uinput` builds reject the multi-op `-d/-m/-u` form with "wrong number of
 * parameters". Prefer {@link sendGesture} (uitest) for those; this path now
 * surfaces such failures instead of silently succeeding.
 */
export async function sendRawTouch(opts: SendRawTouchOptions): Promise<void> {
  const cmd = buildRawTouchCommand(opts.events);
  const res = await shellChecked({ config: opts.config, command: cmd, deviceSerial: opts.deviceSerial, timeoutMs: 30_000, logger: opts.logger });
  ensureRemoteOk(res, `hdc shell ${cmd}`);
}
