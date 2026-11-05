import * as fs from 'node:fs';
import * as readline from 'node:readline';

/**
 * Parsing of `hitrace` text output: ftrace text whose user-space markers are
 * `tracing_mark_write` events.
 *
 * What an OpenHarmony API 26 device writes (seen on a real capture):
 *
 * ```
 *  ample.perfprobe-17599   (  17599) [005] ..... 149437.321439: tracing_mark_write: B|17599|H:ReceiveVsync name:WM_17599 ... vsyncId:16026, fd:26|M0538
 *  ample.perfprobe-17599   (  17599) [005] ..... 149437.337990: tracing_mark_write: E|17599|M0538
 *  OS_IPC_13_4366-4366     (   2693) [006] ..... 149433.777705: tracing_mark_write: B|2693|H:[a92ab18be48d19e,27224d3,0]#virtual int ...StartAbility(...)|I31
 *  RSUniRenderThre-3012    (   2695) [004] ..... 149433.818003: tracing_mark_write: C|2695|H:JANK_FRAME_1-5F|1|M0538
 * ```
 *
 * - `B|<tgid>|H:<name>|<level><tag>` opens a slice on the writing thread,
 *   `E|<tgid>|<level><tag>` closes the innermost one. The trailing level and tag
 *   (`I39`, `M0538`) are new in recent releases; older ones end at the name.
 * - `S|<tgid>|H:<name>|<cookie>|…` / `F|…` start and finish an async slice,
 *   `C|<tgid>|H:<name>|<value>|…` sets a counter.
 * - Names carry an `H:` prefix and, when a HiTraceChain is active, a
 *   `[chainId,spanId,parentSpanId]#` prefix; both are stripped.
 * - The task column is the thread's comm (15 characters at most: an app's
 *   main thread shows the END of its bundle name, `ample.perfprobe`) and its
 *   tid; the parenthesised column is the tgid (`-------` for idle). Traces
 *   recorded without the tgid column parse too (the B/E payload has the tgid).
 *
 * `sched_switch` lines are used, when the `sched` category was on, for the CPU
 * time of main threads (tid == tgid).
 */

/** A closed (or, at the end of the trace, still open) synchronous slice. */
export interface TraceSlice {
  tid: number;
  /** Process (tgid) from the marker. */
  pid: number;
  /** Name without the `H:` and HiTraceChain prefixes. */
  name: string;
  /** Start, ms on the trace clock (boot time by default). */
  ts: number;
  /** Duration, ms; undefined when the slice was still open at the end of the trace. */
  dur?: number;
  /** Nesting depth on its thread, 0 for outermost. */
  depth: number;
}

/** An async slice (`S`/`F` pair). */
export interface TraceAsyncSlice {
  pid: number;
  name: string;
  cookie: string;
  ts: number;
  dur?: number;
}

export interface TraceCounterSample {
  pid: number;
  name: string;
  ts: number;
  value: number;
}

export interface TraceModel {
  slices: TraceSlice[];
  asyncSlices: TraceAsyncSlice[];
  counters: TraceCounterSample[];
  /** tid → its comm (the last one seen), and tid → tgid. */
  threads: Map<number, { comm: string; pid: number }>;
  /** First and last event timestamps, ms. */
  startMs: number;
  endMs: number;
  /** Lines that looked like trace events. */
  eventCount: number;
  /** `tracing_mark_write` events. */
  markerCount: number;
  /** `sched_switch` events seen (0: the sched category was off). */
  schedSwitchCount: number;
  /**
   * CPU time per thread id, ms, from sched_switch (empty without sched data). A
   * process's main thread has tid == pid, so its entry is `get(pid)`; this needs no
   * tgid column.
   */
  mainThreadCpuMs: Map<number, number>;
  /**
   * RenderService surface name → the pid that owns it, from
   * `RSUniRender::QuickPrepare:[<surface>] nodeId[…] pid[<pid>]` (graphic category).
   * An app's main window surface is named after the last part of its bundle
   * name and an index (`perfprobe0`), which identifies the app's process when
   * its thread names did not make it into the trace (`<...>`).
   */
  surfacePids: Map<string, number>;
  /** From the `entries-in-buffer/entries-written: a/b` header, when present. */
  entriesInBuffer?: number;
  entriesWritten?: number;
}

export interface ParseTraceOptions {
  /** Keep only the slices this returns true for (called when a slice closes, and for open ones at the end). Default: all. */
  keepSlice?: (slice: TraceSlice, threadComm: string | undefined) => boolean;
}

/** `  comm-tid  (  tgid) [cpu] flags  ts: function: body`, the tgid column optional. */
const LINE_RE = /^\s*(.{1,32}?)-(\d+)\s+(?:\(\s*([\d-]+)\)\s+)?\[(\d+)\]\s+(?:[^\s]+\s+)?(\d+\.\d+):\s+([\w]+):\s?(.*)$/;
const HEADER_RE = /entries-in-buffer\/entries-written:\s*(\d+)\/(\d+)/;
/** HiTrace's level and tag suffix on recent releases: `I39`, `M0538`, `D62`, `C1`. */
const LEVEL_RE = /^[DICM]\d*$/;
const QUICK_PREPARE_RE = /^RSUniRender::QuickPrepare:\[([^\]]+)\] nodeId\[\d+\] pid\[(\d+)\]/;
const CHAIN_RE = /^\[[0-9a-fA-F]+,[0-9a-fA-F]+,[0-9a-fA-F]+\]#/;

/** `H:[chain]#name` → `name`. Pure. */
export function cleanMarkerName(raw: string): string {
  let n = raw.startsWith('H:') ? raw.slice(2) : raw;
  n = n.replace(CHAIN_RE, '');
  return n;
}

/** The parts of a marker payload after the type and tgid, without the level/tag suffix. */
function payloadParts(parts: string[], minKeep: number): string[] {
  const rest = parts.slice(2);
  if (rest.length > minKeep && LEVEL_RE.test(rest[rest.length - 1]!)) rest.pop();
  if (rest.length > minKeep && rest[rest.length - 1] === '') rest.pop();
  return rest;
}

/** Incremental parser; feed lines, then `finish()`. */
export class TraceParser {
  private readonly model: TraceModel = {
    slices: [],
    asyncSlices: [],
    counters: [],
    threads: new Map(),
    startMs: Number.NaN,
    endMs: Number.NaN,
    eventCount: 0,
    markerCount: 0,
    schedSwitchCount: 0,
    mainThreadCpuMs: new Map(),
    surfacePids: new Map(),
  };
  private readonly stacks = new Map<number, Array<{ name: string; ts: number; pid: number }>>();
  private readonly openAsync = new Map<string, { pid: number; name: string; cookie: string; ts: number }>();
  private readonly switchedIn = new Map<number, number>();
  private headerDone = false;

  constructor(private readonly opts: ParseTraceOptions = {}) {}

  line(raw: string): void {
    if (raw.startsWith('#') || raw.length === 0) {
      if (!this.headerDone) {
        const h = HEADER_RE.exec(raw);
        if (h) {
          this.model.entriesInBuffer = Number(h[1]);
          this.model.entriesWritten = Number(h[2]);
        }
      }
      return;
    }
    const isMark = raw.includes('tracing_mark_write');
    const isSwitch = !isMark && raw.includes('sched_switch');
    if (!isMark && !isSwitch) {
      // Only the bounds matter for other events; avoid the regex on most lines.
      const m = /\s(\d+\.\d+):\s/.exec(raw);
      if (m) this.bound(Number(m[1]) * 1000);
      return;
    }
    const m = LINE_RE.exec(raw);
    if (!m) return;
    this.headerDone = true;
    const comm = m[1]!.trim();
    const tid = Number(m[2]);
    const tgidCol = m[3] && m[3] !== '-------' && /^\d+$/.test(m[3]) ? Number(m[3]) : undefined;
    const ts = Number(m[5]) * 1000;
    const fn = m[6]!;
    const body = m[7]!;
    this.bound(ts);
    if (fn === 'sched_switch') {
      this.model.schedSwitchCount++;
      this.schedSwitch(tid, ts, body);
      return;
    }
    if (fn !== 'tracing_mark_write') return;
    this.model.markerCount++;
    this.marker(comm, tid, tgidCol, ts, body.trim());
  }

  private bound(ts: number): void {
    this.model.eventCount++;
    if (Number.isNaN(this.model.startMs) || ts < this.model.startMs) this.model.startMs = ts;
    if (Number.isNaN(this.model.endMs) || ts > this.model.endMs) this.model.endMs = ts;
  }

  private schedSwitch(prevTid: number, ts: number, body: string): void {
    const next = /next_pid=(\d+)/.exec(body);
    const since = this.switchedIn.get(prevTid);
    if (since !== undefined) {
      this.model.mainThreadCpuMs.set(prevTid, (this.model.mainThreadCpuMs.get(prevTid) ?? 0) + (ts - since));
    }
    this.switchedIn.delete(prevTid);
    if (next) this.switchedIn.set(Number(next[1]), ts);
  }

  private marker(comm: string, tid: number, tgidCol: number | undefined, ts: number, body: string): void {
    const parts = body.split('|');
    const type = parts[0];
    const pid = Number(parts[1]) || tgidCol || tid;
    this.model.threads.set(tid, { comm, pid: tgidCol ?? pid });
    switch (type) {
      case 'B': {
        const name = cleanMarkerName(payloadParts(parts, 1).join('|'));
        if (name.startsWith('RSUniRender::QuickPrepare:[')) {
          const q = QUICK_PREPARE_RE.exec(name);
          if (q) this.model.surfacePids.set(q[1]!, Number(q[2]));
        }
        let stack = this.stacks.get(tid);
        if (!stack) this.stacks.set(tid, (stack = []));
        stack.push({ name, ts, pid });
        return;
      }
      case 'E': {
        const stack = this.stacks.get(tid);
        const open = stack?.pop();
        if (!open) return; // the slice began before the capture
        this.close({ tid, pid: open.pid, name: open.name, ts: open.ts, dur: ts - open.ts, depth: stack!.length });
        return;
      }
      case 'S':
      case 'F': {
        const rest = payloadParts(parts, 2);
        const cookie = rest.length > 1 ? rest.pop()! : '';
        const name = cleanMarkerName(rest.join('|'));
        const key = `${pid}|${name}|${cookie}`;
        if (type === 'S') {
          this.openAsync.set(key, { pid, name, cookie, ts });
        } else {
          const open = this.openAsync.get(key);
          if (!open) return;
          this.openAsync.delete(key);
          this.model.asyncSlices.push({ ...open, dur: ts - open.ts });
        }
        return;
      }
      case 'C': {
        const rest = payloadParts(parts, 2);
        const value = Number(rest.pop());
        if (!Number.isFinite(value)) return;
        this.model.counters.push({ pid, name: cleanMarkerName(rest.join('|')), ts, value });
        return;
      }
      default:
        return;
    }
  }

  private close(slice: TraceSlice): void {
    if (this.opts.keepSlice && !this.opts.keepSlice(slice, this.model.threads.get(slice.tid)?.comm)) return;
    this.model.slices.push(slice);
  }

  finish(): TraceModel {
    for (const [tid, stack] of this.stacks) {
      stack.forEach((open, depth) => this.close({ tid, pid: open.pid, name: open.name, ts: open.ts, depth }));
    }
    this.stacks.clear();
    for (const open of this.openAsync.values()) this.model.asyncSlices.push({ ...open });
    this.openAsync.clear();
    this.model.slices.sort((a, b) => a.ts - b.ts);
    this.model.asyncSlices.sort((a, b) => a.ts - b.ts);
    if (Number.isNaN(this.model.startMs)) this.model.startMs = 0;
    if (Number.isNaN(this.model.endMs)) this.model.endMs = this.model.startMs;
    return this.model;
  }
}

/** Parse hitrace text held in memory. Pure. */
export function parseTraceText(text: string, opts: ParseTraceOptions = {}): TraceModel {
  const p = new TraceParser(opts);
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    p.line(text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end));
    start = end + 1;
  }
  return p.finish();
}

/** Parse a hitrace text file, streaming it line by line (traces run to hundreds of MB). */
export async function parseTraceFile(file: string, opts: ParseTraceOptions = {}): Promise<TraceModel> {
  const p = new TraceParser(opts);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) p.line(line);
  return p.finish();
}
