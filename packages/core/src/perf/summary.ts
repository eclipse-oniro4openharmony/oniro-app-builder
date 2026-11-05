import type { TraceModel, TraceSlice } from './hitrace.js';

/**
 * Turn a parsed hitrace capture into the numbers a performance gate needs:
 * the app's frames (janky ones against the display's refresh interval), its
 * cold-start time, main-thread load, and RenderService's own per-scene jank
 * reports. Pure.
 *
 * Markers this relies on, as an OpenHarmony API 26 device (ArkUI, RenderService,
 * ability runtime) emits them with the `ace graphic app ability window`
 * categories:
 *
 * - Frames: on the app's main thread (tid == pid) each UI frame is one
 *   `ReceiveVsync name:WM_<pid> … now:<vsync ns> expectedEnd:<ns> vsyncId:<n>`
 *   slice enclosing `OnVsyncEvent` → `UIVsyncTask` → `FlushLayoutTask` /
 *   `FlushRenderTask`. ArkUI only asks for a vsync when something is dirty, so
 *   an idle app writes no frames. A frame's time is from its vsync (`now:`) to
 *   the end of the slice, so a frame whose callback was held up by other work on
 *   the main thread counts the wait too; it is janky when that exceeds one
 *   refresh interval (the UI missed the next vsync).
 * - Refresh interval: `VSyncReceiver:period:<ns>` inside those frames, else
 *   `refreshPeriod is: <ns>`, else the caller's rate (hidumper), else 60 Hz.
 * - Cold start: from `AbilityManagerClient::StartAbility` on the `aa` tool's
 *   thread (else `AbilityManagerService::StartAbility` in foundation) before the
 *   app's process appears, to `RSJankStats::ReportEventFirstFrame app pid <pid>`
 *   in render_service (the first frame composited), else to the end of the app's
 *   first UI frame.
 * - Scenes: `RSJankStats::ReportEventJankFrame maxFrameTime is …`,
 *   `ReportEventHitchTimeRatio hitch time ratio is … ms/s` and
 *   `ReportEventResponse responseLatency is …ms` name a scene (APP_LIST_FLING,
 *   ABILITY_OR_PAGE_SWITCH, …) and the bundle.
 */

export interface PerfFrameStats {
  /** UI frames the app's main thread produced. */
  total: number;
  /** Frames that took longer than one refresh interval (vsync to done). */
  janky: number;
  /** janky / total (0 without frames). */
  jankRate: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Refresh intervals missed in all: Σ floor(frame / interval). */
  missedVsyncs: number;
  /** The longest frames, longest first: offset from the trace start and duration, ms. */
  longest: Array<{ atMs: number; ms: number }>;
}

export interface PerfStartup {
  /** Launch request to the app's first frame on screen, ms. */
  coldMs: number;
  /** The app's first UI frame on its main thread (initial build, measure, layout), ms. */
  firstFrameMs: number | null;
  /** Launch request to the app's process being forked, ms. */
  processMs: number | null;
  /** Where coldMs starts and ends. */
  from: string;
  to: string;
}

export interface PerfScene {
  /** RenderService's scene id, e.g. APP_LIST_FLING, ABILITY_OR_PAGE_SWITCH. */
  scene: string;
  page?: string;
  maxFrameMs?: number;
  maxHitchMs?: number;
  hitchMsPerS?: number;
  responseMs?: number;
}

export interface TraceSummary {
  /** The app's process (main thread id). */
  pid: number | null;
  /** Length of the capture, ms. */
  durationMs: number;
  refreshRateHz: number;
  frames: PerfFrameStats;
  startup: PerfStartup | null;
  mainThread: {
    /** Time in top-level traced slices on the main thread, ms. */
    busyMs: number;
    /** CPU time of the main thread, ms (only with the `sched` category). */
    cpuMs: number | null;
  };
  scenes: PerfScene[];
  notes: string[];
}

export interface SummarizeTraceOptions {
  bundle: string;
  /** The app's pid when known (e.g. `pidof` after the capture); otherwise found from the trace. */
  pid?: number;
  /** Refresh rate to use when the trace has no vsync period. */
  refreshRateHz?: number;
  /** The capture cold-launched the app: report startup, and leave its first frame out of the frame stats. */
  launched?: boolean;
}

const FRAME_RE = /^ReceiveVsync\b/;
const FRAME_FALLBACK_RE = /^OnVsyncEvent\b/;
const PERIOD_RE = /^VSyncReceiver:period:(\d+)/;
const RS_PERIOD_RE = /refreshPeriod is: (\d+)/;
const START_CLIENT_RE = /AbilityManagerClient::StartAbility\(/;
const START_SERVICE_RE = /AbilityManagerService::StartAbility\(/;
const FIRST_FRAME_RE = /^RSJankStats::ReportEventFirstFrame app pid (\d+)/;
const SPAWN_RE = /^AppSpawn|HandleLaunchApplication|HandleScheduleLaunchApplication/;

/** Slices the summary needs; pass as `keepSlice` to keep memory flat on long captures. */
export function perfSliceFilter(slice: TraceSlice): boolean {
  if (slice.tid === slice.pid && slice.depth === 0) return true;
  const n = slice.name;
  return (
    FRAME_RE.test(n) ||
    FRAME_FALLBACK_RE.test(n) ||
    PERIOD_RE.test(n) ||
    RS_PERIOD_RE.test(n) ||
    n.startsWith('RSJankStats::') ||
    START_CLIENT_RE.test(n) ||
    START_SERVICE_RE.test(n) ||
    SPAWN_RE.test(n)
  );
}

/** The thread name an app's main thread gets: the bundle name, cut to its last (or first) 15 characters. */
export function commMatchesBundle(comm: string, bundle: string): boolean {
  if (!comm) return false;
  if (comm === bundle) return true;
  const n = Math.min(15, bundle.length);
  return comm.length >= n && (bundle.endsWith(comm) || bundle.startsWith(comm));
}

const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

/** The q-quantile (0..1) of sorted values, nearest-rank. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/** Candidate app pids: main threads named after the bundle, and pids whose markers name it (`…##<bundle>`). */
export function findAppPids(model: TraceModel, bundle: string): number[] {
  const pids = new Set<number>();
  for (const [tid, t] of model.threads) if (tid === t.pid && commMatchesBundle(t.comm, bundle)) pids.add(tid);
  for (const s of model.slices) if (s.tid === s.pid && s.name.endsWith(`##${bundle}`)) pids.add(s.pid);
  return [...pids];
}

/** Pids owning a RenderService surface named `<last part of the bundle><index>`, the app's main window. */
export function findAppPidsBySurface(model: TraceModel, bundle: string): number[] {
  const last = bundle.split('.').pop()!.replace(/\W/g, '');
  if (!last) return [];
  const re = new RegExp(`^${last}\\d+$`);
  const pids = new Set<number>();
  for (const [surface, pid] of model.surfacePids) if (re.test(surface)) pids.add(pid);
  return [...pids];
}

interface Frame {
  slice: TraceSlice;
  /** Vsync to end of the frame (or the slice's duration when the vsync time is not usable), ms. */
  ms: number;
}

function appFrames(model: TraceModel, pid: number): Frame[] {
  const mine = model.slices.filter((s) => s.tid === pid && s.dur !== undefined);
  let frames = mine.filter((s) => FRAME_RE.test(s.name));
  if (frames.length === 0) frames = mine.filter((s) => FRAME_FALLBACK_RE.test(s.name));
  // Outermost only (a nested one would be counted twice). Slices are sorted by start.
  let outerEnd = -Infinity;
  frames = frames.filter((s) => {
    if (s.ts < outerEnd) return false;
    outerEnd = s.ts + s.dur!;
    return true;
  });
  return frames.map((slice) => {
    const end = slice.ts + slice.dur!;
    const now = /\bnow:(\d+)/.exec(slice.name);
    const vsyncMs = now ? Number(now[1]) / 1e6 : Number.NaN;
    // The vsync timestamp is on the same (boot) clock as the trace; ignore it if not.
    const usable = Number.isFinite(vsyncMs) && vsyncMs <= slice.ts + 0.5 && slice.ts - vsyncMs < 2000;
    return { slice, ms: usable ? end - vsyncMs : slice.dur! };
  });
}

function framePeriodMs(model: TraceModel, pid: number | null): number | undefined {
  const own: number[] = [];
  const any: number[] = [];
  for (const s of model.slices) {
    const p = PERIOD_RE.exec(s.name);
    if (p) (s.pid === pid ? own : any).push(Number(p[1]) / 1e6);
    else {
      const r = RS_PERIOD_RE.exec(s.name);
      if (r) any.push(Number(r[1]) / 1e6);
    }
  }
  const ms = median(own) ?? median(any);
  return ms && ms > 2 && ms < 100 ? ms : undefined;
}

function frameStats(frames: Frame[], periodMs: number, startMs: number): PerfFrameStats {
  const ms = frames.map((f) => f.ms);
  const sorted = [...ms].sort((a, b) => a - b);
  const janky = ms.filter((m) => m > periodMs).length;
  return {
    total: frames.length,
    janky,
    jankRate: frames.length ? round(janky / frames.length, 4) : 0,
    p50Ms: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    missedVsyncs: ms.reduce((n, m) => n + Math.floor(m / periodMs), 0),
    longest: [...frames]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map((f) => ({ atMs: round(f.slice.ts - startMs), ms: round(f.ms) })),
  };
}

function startupOf(model: TraceModel, pid: number, frames: Frame[], notes: string[]): PerfStartup | null {
  const own = model.slices.filter((s) => s.pid === pid);
  const spawned = own.find((s) => SPAWN_RE.test(s.name));
  if (!spawned) {
    notes.push('The app process was already running when the capture started: no startup time.');
    return null;
  }
  const processTs = Math.min(spawned.ts, own[0]?.ts ?? spawned.ts);
  const before = (re: RegExp, comm?: string): TraceSlice | undefined =>
    model.slices.filter((s) => re.test(s.name) && s.ts <= processTs && (!comm || model.threads.get(s.tid)?.comm === comm)).pop();
  let from = 'aa StartAbility';
  let start = before(START_CLIENT_RE, 'aa');
  if (!start) {
    from = 'AbilityManagerService::StartAbility';
    start = before(START_SERVICE_RE);
  }
  if (!start) {
    from = 'app process start';
    notes.push('No StartAbility marker before the app process started (is the `ability` category on?); startup is measured from the process start.');
  }
  const startTs = start?.ts ?? processTs;

  let to = 'first frame composited (RSJankStats::ReportEventFirstFrame)';
  let endTs = model.slices.find((s) => {
    const m = FIRST_FRAME_RE.exec(s.name);
    return m && Number(m[1]) === pid && s.ts >= startTs;
  })?.ts;
  const first = frames.find((f) => f.slice.ts >= processTs);
  if (endTs === undefined && first) {
    to = 'end of the first UI frame';
    endTs = first.slice.ts + first.slice.dur!;
    notes.push('RenderService wrote no first-frame marker for the app (is the `graphic` category on?); startup ends at its first UI frame.');
  }
  if (endTs === undefined) {
    notes.push('The app drew no frame during the capture: no startup time.');
    return null;
  }
  return {
    coldMs: round(endTs - startTs),
    firstFrameMs: first ? round(first.slice.dur!) : null,
    processMs: start ? round(processTs - startTs) : null,
    from,
    to,
  };
}

const SCENE_TAIL = /:\s*([A-Z0-9_]+),\s*([^,]+),\s*([^,]*),/;

function scenesOf(model: TraceModel, bundle: string): PerfScene[] {
  const scenes = new Map<string, PerfScene>();
  const get = (scene: string, page: string): PerfScene => {
    const key = `${scene}|${page}`;
    let s = scenes.get(key);
    if (!s) scenes.set(key, (s = { scene, ...(page ? { page } : {}) }));
    return s;
  };
  for (const sl of model.slices) {
    if (!sl.name.startsWith('RSJankStats::Report')) continue;
    const tail = SCENE_TAIL.exec(sl.name);
    if (!tail || tail[2]!.trim() !== bundle) continue;
    const s = get(tail[1]!, tail[3]!.trim());
    const jank = /maxFrameTime is (\d+)ms, maxHitchTime is (\d+)ms/.exec(sl.name);
    if (jank) {
      s.maxFrameMs = Math.max(s.maxFrameMs ?? 0, Number(jank[1]));
      s.maxHitchMs = Math.max(s.maxHitchMs ?? 0, Number(jank[2]));
    }
    const hitch = /hitch time ratio is ([\d.]+) ms\/s/.exec(sl.name);
    if (hitch) s.hitchMsPerS = Math.max(s.hitchMsPerS ?? 0, Number(hitch[1]));
    const resp = /responseLatency is (\d+)ms/.exec(sl.name);
    if (resp) s.responseMs = Math.max(s.responseMs ?? 0, Number(resp[1]));
  }
  return [...scenes.values()];
}

/** Summarise a capture for one bundle. Pure. */
export function summarizeTrace(model: TraceModel, opts: SummarizeTraceOptions): TraceSummary {
  const notes: string[] = [];
  const durationMs = round(model.endMs - model.startMs);
  if (model.entriesWritten !== undefined && model.entriesInBuffer !== undefined && model.entriesWritten > model.entriesInBuffer) {
    notes.push(
      `The trace buffer overflowed (${model.entriesWritten - model.entriesInBuffer} of ${model.entriesWritten} events lost); ` +
        'the start of the capture may be missing. Use a bigger buffer or fewer categories.',
    );
  }
  if (model.markerCount === 0) notes.push('The trace has no tracing_mark_write events (were the ace/graphic categories on?).');

  let pid: number | null = null;
  let candidates = findAppPids(model, opts.bundle);
  if (candidates.length === 0 && opts.pid === undefined) {
    candidates = findAppPidsBySurface(model, opts.bundle);
    if (candidates.length) {
      notes.push(`The app's thread names are not in the trace; its process was found from its RenderService surface (pid ${candidates.join(', ')}).`);
    }
  }
  if (opts.pid !== undefined && (candidates.length === 0 || candidates.includes(opts.pid))) pid = opts.pid;
  else if (candidates.length === 1) pid = candidates[0]!;
  else if (candidates.length > 1) {
    // A relaunch leaves two: the launched one when we launched, else the one that drew the most.
    const score = (p: number): number =>
      (opts.launched && model.slices.some((s) => s.pid === p && SPAWN_RE.test(s.name)) ? 1e9 : 0) + appFrames(model, p).length;
    pid = [...candidates].sort((a, b) => score(b) - score(a))[0]!;
    notes.push(`Several processes of ${opts.bundle} in the trace (${candidates.join(', ')}); summarised ${pid}.`);
  }
  if (pid === null) notes.push(`No process of ${opts.bundle} in the trace.`);

  let periodMs = framePeriodMs(model, pid);
  if (periodMs === undefined) {
    if (opts.refreshRateHz && opts.refreshRateHz > 0) periodMs = 1000 / opts.refreshRateHz;
    else {
      periodMs = 1000 / 60;
      notes.push('No vsync period in the trace and no refresh rate given; assumed 60 Hz.');
    }
  }
  const refreshRateHz = round(1000 / periodMs);

  let frames = pid !== null ? appFrames(model, pid) : [];
  const startup = pid !== null && opts.launched ? startupOf(model, pid, frames, notes) : null;
  if (opts.launched && frames.length > 0) {
    // The first frame waits for the page to load; startup reports it, the jank stats should not.
    frames = frames.slice(1);
    notes.push('The first frame after launch is reported under startup, not in the frame stats.');
  }
  if (pid !== null && frames.length === 0) {
    notes.push('The app drew no frames during the capture (it was idle or not in the foreground).');
  }

  const main = pid !== null ? model.slices.filter((s) => s.tid === pid && s.depth === 0 && s.dur !== undefined) : [];
  const cpu = pid !== null && model.schedSwitchCount > 0 ? (model.mainThreadCpuMs.get(pid) ?? 0) : null;

  return {
    pid,
    durationMs,
    refreshRateHz,
    frames: frameStats(frames, periodMs, model.startMs),
    startup,
    mainThread: { busyMs: round(main.reduce((n, s) => n + s.dur!, 0)), cpuMs: cpu === null ? null : round(cpu) },
    scenes: scenesOf(model, opts.bundle),
    notes,
  };
}
