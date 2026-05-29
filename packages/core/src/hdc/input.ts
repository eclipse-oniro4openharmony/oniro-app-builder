import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { shell, ensureOk } from './exec.js';

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
  const res = await shell({ config: opts.config, command: cmd, deviceSerial: opts.deviceSerial, timeoutMs: 30_000, logger: opts.logger });
  ensureOk(res, `hdc shell ${cmd}`);
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

function waypointsToRawEvents(waypoints: Waypoint[], holdStartMs = 0, holdEndMs = 0): RawTouchEvent[] {
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

/**
 * Drive a smooth multi-waypoint path. With no holds, issues chained
 * `uitest uiInput drag` segments. When `holdStartMs`/`holdEndMs` are set, routes
 * through {@link sendRawTouch} (uinput), the only path with real press-time control.
 */
export async function sendGesture(opts: SendGestureOptions): Promise<void> {
  const wantsHold = (opts.holdStartMs ?? 0) > 0 || (opts.holdEndMs ?? 0) > 0;
  if (wantsHold) {
    await sendRawTouch({
      config: opts.config,
      events: waypointsToRawEvents(opts.waypoints, opts.holdStartMs, opts.holdEndMs),
      deviceSerial: opts.deviceSerial,
      logger: opts.logger,
    });
    return;
  }
  for (const cmd of buildGestureCommands(opts.waypoints)) {
    const res = await shell({ config: opts.config, command: cmd, deviceSerial: opts.deviceSerial, timeoutMs: 30_000, logger: opts.logger });
    ensureOk(res, `hdc shell ${cmd}`);
  }
}

/**
 * Low-level touch injection via `uinput -T`. The escape hatch when press timing
 * matters (e.g. Quickstep motion-pause), which `uitest uiInput` can't express.
 *
 * WARNING: uinput's gesture form `uinput -T -g x1 y1 x2 y2 [press] [total]`
 * silently no-ops if `press < 500ms` or `total - press < 500ms` ("press time is
 * out of range" — it runs nothing). Keep press and post-press windows ≥ 500ms.
 */
export async function sendRawTouch(opts: SendRawTouchOptions): Promise<void> {
  const cmd = buildRawTouchCommand(opts.events);
  const res = await shell({ config: opts.config, command: cmd, deviceSerial: opts.deviceSerial, timeoutMs: 30_000, logger: opts.logger });
  ensureOk(res, `hdc shell ${cmd}`);
}
