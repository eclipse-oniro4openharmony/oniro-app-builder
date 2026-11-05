/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/faultlog/crash/crash-analyzer.ts`), Copyright (c) 2026
 * Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/faultlog/NOTICE.md.
 */
import { buildPropagation, nodeLabel, type BinderEdge, type BinderTransaction } from './binder.js';
import { isCrashJson, renderCrashJson } from './crashJson.js';
import { classifyFaultLog, type FaultCompleteness, type FaultConfidence, type FaultLogKind } from './classify.js';
import { parseFrame, type JsFrame, type NativeFrame, type StackFrame } from './frames.js';
import { parseCppCrash, parseFreeze, parseJsCrash, type FreezeLog } from './parsers.js';
import { splitLines } from './text.js';

/** One fault, read from a faultlog: what kind, where it happened, and why. */
export interface CrashVerdict {
  /** A process fault (`cpp_crash`, `js_crash` or `app_freeze`); false for a sample stack or an unrecognised log. */
  crashed: boolean;
  kind: FaultLogKind;
  /** For `app_freeze`, the event (`THREAD_BLOCK_6S`, `APP_INPUT_BLOCK`, `LIFECYCLE_TIMEOUT`). */
  subtype: string | null;
  confidence: FaultConfidence;
  completeness: FaultCompleteness;
  /** The app's bundle name (`Module name:` of an app's faultlog; for a native service, its module). */
  bundle: string | null;
  process: string | null;
  pid: number | null;
  uid: number | null;
  /** The faulting (or blocked) thread. */
  tid: number | null;
  threadName: string | null;
  /** When the fault happened, as the log prints it (device local time, `YYYY-MM-DD HH:MM:SS.mmm`). */
  time: string | null;
  /** `Reason:` — the signal (`Signal:SIGSEGV(SEGV_MAPERR)@0x0 …`), the JS error class, or the freeze event. */
  reason: string | null;
  /** The top frame of the faulting thread, as printed. */
  topFrame: string | null;
  /** The first frame in the app's own code: an ArkTS frame under `<module>/src/main/`, else a native frame in the app's libraries. */
  projectFrame: string | null;
  /** Source position of the first project ArkTS frame, as the log prints it (`entry/src/main/ets/pages/Index.ets`). */
  file: string | null;
  line: number | null;
  column: number | null;
  /** For a JS crash: the error and its stack. */
  jsError: { name: string; message: string; stack: string[] } | null;
  /** Every frame of the faulting thread as printed, native and ArkTS interleaved, top first (for a freeze, from the first report). */
  stack: string[];
  /** Native frames of the faulting thread (for a freeze, from the first report). */
  nativeFrames: NativeFrame[];
  /** ArkTS frames of the faulting thread. */
  jsFrames: JsFrame[];
  /** For a freeze: the synchronous binder calls the blocked thread is part of, longest wait first. */
  binderChain: BinderEdge[];
  /** For a freeze: binder deadlock cycles, `a -> b -> a`. */
  deadlocks: string[];
  /** Notes on the binder chain, the stack capture, or the classification. */
  notes: string[];
  /** cppcrash `LastFatalMessage:` (an abort message), when present. */
  lastFatalMessage: string | null;
  /** cppcrash GWP-ASan report, when present. */
  gwpAsan: string | null;
  /** Why the kind was chosen. */
  evidence: string[];
  /** The faultlog's file name, e.g. `jscrash-com.example.app-20010043-20261105123257298.log`. */
  name: string | null;
  /** Where the faultlog is: its path on the device, or the local file it was read from. */
  path: string | null;
  /** A local copy of the whole faultlog, when one was saved. */
  rawPath: string | null;
}

export interface AnalyzeFaultLogOptions {
  name?: string;
  path?: string;
  rawPath?: string;
}

const toInt = (value: string | undefined): number | null => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : null;
};
const orNull = (value: string | undefined): string | null => (value ? value : null);

/** Freeze logs print `2026/11/05-12:42:29[:053]`; give every kind `2026-11-05 12:42:29[.053]`. */
export function normalizeFaultTime(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})\/(\d{2})\/(\d{2})-(\d{2}:\d{2}:\d{2})(?:[:.](\d{1,3}))?$/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}${m[5] ? `.${m[5].padStart(3, '0')}` : ''}` : value.trim();
}

function natives(frames: readonly StackFrame[]): NativeFrame[] {
  return frames.filter((f): f is StackFrame & { kind: 'native' } => f.kind === 'native').map(({ kind: _kind, ...frame }) => frame);
}
function jsOnly(frames: readonly StackFrame[]): JsFrame[] {
  return frames.filter((f): f is StackFrame & { kind: 'js' } => f.kind === 'js').map(({ kind: _kind, ...frame }) => frame);
}

/** An excerpt without thread headers or a Stacktrace title: every frame line, in order. */
function looseFrames(lines: readonly string[]): StackFrame[] {
  return lines.map((line) => parseFrame(line)).filter((f): f is StackFrame => f !== null);
}

/** The location fields every kind derives from the faulting thread's frames. */
function location(frames: readonly StackFrame[]): Pick<CrashVerdict, 'topFrame' | 'projectFrame' | 'file' | 'line' | 'column' | 'stack' | 'nativeFrames' | 'jsFrames'> {
  const js = jsOnly(frames);
  const native = natives(frames);
  const projectJs = js.find((f) => f.project);
  const projectNative = native.find((f) => f.area === 'app');
  return {
    topFrame: frames[0]?.raw ?? null,
    projectFrame: projectJs?.raw ?? projectNative?.raw ?? null,
    file: projectJs?.file ?? null,
    line: projectJs?.line ?? null,
    column: projectJs?.column ?? null,
    stack: frames.map((f) => f.raw),
    nativeFrames: native,
    jsFrames: js,
  };
}

function binderEdges(log: FreezeLog, edges: BinderTransaction[]): BinderEdge[] {
  const threadNames = new Map<string, string>();
  for (const report of log.block ? [log.warning, log.block] : [log.warning]) {
    for (const [tid, stack] of report.stacks) if (stack.name) threadNames.set(`${log.pid}:${tid}`, stack.name);
  }
  return edges.map((t) => ({
    from: nodeLabel({ pid: t.srcPid, tid: t.srcTid }, log.processNames, threadNames),
    to: nodeLabel({ pid: t.dstPid, tid: t.dstTid }, log.processNames, threadNames),
    waitSeconds: t.waitSeconds,
    code: t.code,
    ...(t.frzState ? { frzState: t.frzState } : {}),
  }));
}

/**
 * Classify a faultlog and read its fault: kind and confidence, the process, the
 * reason, the top and first project frames (with `file:line:column` for ArkTS),
 * the JS error, the native frames and, for a freeze, the binder chain.
 */
export function analyzeFaultLog(input: string, opts: AnalyzeFaultLogOptions = {}): CrashVerdict {
  const fromJson = isCrashJson(input);
  const text = fromJson ? renderCrashJson(input) : input;
  const classification = classifyFaultLog(text);
  const lines = splitLines(text);
  const base: CrashVerdict = {
    crashed: false,
    kind: classification.kind,
    subtype: classification.subtype ?? null,
    confidence: classification.confidence,
    completeness: classification.completeness,
    bundle: null, process: null, pid: null, uid: null, tid: null, threadName: null, time: null, reason: null,
    topFrame: null, projectFrame: null, file: null, line: null, column: null,
    jsError: null, stack: [], nativeFrames: [], jsFrames: [], binderChain: [], deadlocks: [], notes: [],
    lastFatalMessage: null, gwpAsan: null,
    evidence: classification.evidence,
    name: opts.name ?? null,
    path: opts.path ?? null,
    rawPath: opts.rawPath ?? null,
  };
  if (fromJson) base.notes.push('Read from the faultloggerd crash record; hiview wrote no faultlog for this crash.');
  if (classification.outOfScope) base.notes.push(classification.outOfScope.detail);
  if (classification.kind === 'unknown' && classification.candidates.length > 0) {
    base.notes.push(`Matches more than one kind: ${classification.candidates.map((c) => c.kind).join(', ')}.`);
  }

  if (classification.kind === 'cpp_crash') {
    const log = parseCppCrash(lines);
    let frames = log.faultThread?.frames ?? [];
    if (frames.length === 0 && classification.completeness === 'fragment') frames = looseFrames(lines);
    if (frames.length === 0) base.notes.push('No stack for the crashing thread.');
    return {
      ...base,
      crashed: true,
      bundle: orNull(log.header.module),
      process: orNull(log.header.process ?? log.header.module),
      pid: toInt(log.header.pid),
      uid: toInt(log.header.uid),
      tid: toInt(log.faultThread?.tid),
      threadName: orNull(log.faultThread?.name),
      time: normalizeFaultTime(log.header.timestamp),
      reason: orNull(log.header.reason),
      ...location(frames),
      lastFatalMessage: orNull(log.header.lastFatalMessage),
      gwpAsan: orNull(log.gwpAsan),
    };
  }

  if (classification.kind === 'js_crash') {
    const log = parseJsCrash(lines);
    if (log.frames.length === 0 && classification.completeness === 'fragment') {
      log.frames = looseFrames(lines);
      log.stack = log.frames.map((f) => f.raw);
    }
    if (log.frames.length === 0) base.notes.push('No Stacktrace frames.');
    const name = log.header.errorName ?? log.header.reason ?? '';
    return {
      ...base,
      crashed: true,
      bundle: orNull(log.header.module ?? log.header.package),
      process: orNull(log.header.process ?? log.header.package ?? log.header.module),
      pid: toInt(log.header.pid),
      uid: toInt(log.header.uid),
      tid: toInt(log.faultTid),
      threadName: orNull(log.faultThreadName),
      time: normalizeFaultTime(log.header.faultTime ?? log.header.timestamp),
      reason: orNull(log.header.reason ?? log.header.errorName),
      ...location(log.frames),
      jsError: { name, message: log.header.errorMessage ?? '', stack: log.stack },
    };
  }

  if (classification.kind === 'app_freeze') {
    const log = parseFreeze(lines);
    const stack = log.warning.stacks.get(log.faultTid) ?? null;
    const notes = [...base.notes];
    if (!stack || stack.frames.length === 0) {
      notes.push(...(log.warning.stackErrors.length > 0 ? log.warning.stackErrors : ['No stack for the blocked thread.']));
    }
    const propagation = buildPropagation(log.binder, log.pid, log.faultTid);
    notes.push(...propagation.notes);
    const threadNames = new Map<string, string>();
    for (const [tid, s] of log.warning.stacks) if (s.name) threadNames.set(`${log.pid}:${tid}`, s.name);
    return {
      ...base,
      crashed: true,
      bundle: orNull(log.header.module ?? log.process),
      process: orNull(log.process),
      pid: toInt(log.pid),
      tid: toInt(log.faultTid),
      threadName: orNull(stack?.name),
      time: normalizeFaultTime(log.warning.msg.faultTime ?? log.warning.msg.timestamp),
      reason: orNull(log.reason),
      ...location(stack?.frames ?? []),
      binderChain: binderEdges(log, propagation.edges),
      deadlocks: propagation.cycles.map((cycle) => {
        const labels = cycle.map((node) => nodeLabel(node, log.processNames, threadNames));
        return `${labels.join(' -> ')} -> ${labels[0]}`;
      }),
      notes,
    };
  }

  return base;
}
