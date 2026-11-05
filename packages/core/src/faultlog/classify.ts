/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/faultlog/identify/classify.ts`,
 * `identify/identify-faultlog.ts`, `types.ts`), Copyright (c) 2026 Huawei
 * Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/faultlog/NOTICE.md.
 */
import { OniroError } from '../ports/errors.js';

/**
 * What a faultlog is. `sample_stack` is the periodic stack sampling hiview adds
 * to a freeze (`freeze-cpuinfo-ext-*`), not a fault of its own.
 */
export type FaultLogKind = 'cpp_crash' | 'js_crash' | 'app_freeze' | 'sample_stack' | 'unknown';
/** The three kinds that are a fault of the process. */
export type FaultLogFamily = 'cpp_crash' | 'js_crash' | 'app_freeze';
export const FAULT_LOG_FAMILIES: readonly FaultLogFamily[] = ['cpp_crash', 'js_crash', 'app_freeze'];
export type FaultConfidence = 'high' | 'medium' | 'low';
/** `full`: the faultlog's header region is present; `fragment`: a pasted excerpt. */
export type FaultCompleteness = 'full' | 'fragment';

export interface FaultLogClassification {
  kind: FaultLogKind;
  /** For `app_freeze`, the event (`THREAD_BLOCK_6S`, `APP_INPUT_BLOCK`, `LIFECYCLE_TIMEOUT`). */
  subtype?: string;
  confidence: FaultConfidence;
  completeness: FaultCompleteness;
  /** Why the kind was chosen. */
  evidence: string[];
  /** Why each other kind was ruled out. */
  excluded: Array<{ kind: FaultLogFamily; reason: string }>;
  /** Set when several kinds matched and no rule picks one (`kind: 'unknown'`), or the runner-up of a mixed fragment. */
  candidates: Array<{ kind: FaultLogFamily; confidence: FaultConfidence; evidence: string[]; arbitrable: boolean }>;
  /** Set when the input is not a faultlog at all. */
  outOfScope?: { reason: 'empty' | 'hilog_stream' | 'other_platform'; detail: string };
}

/** A faultlog above this is refused rather than silently truncated. */
export const MAX_FAULTLOG_BYTES = 20 * 1024 * 1024;
/** Above this, only the head and tail are classified. */
const SAMPLE_BYTES = 512 * 1024;

const NATIVE_FRAME = /^\s*#\d+\s+pc\s+[0-9a-fA-F]+\s+\S+/;
// Upstream matches `at f (file:l:c)` only; devices print `at f entry (file:l:c)`.
const JS_FRAME = /^\s*(?:#\d+\s+)?at\s+[^(]*\([^)]*\.(?:ets|ts|js):\d+:\d+\)/;
const HEADER_REASON = /(?:^|\n)\s*Reason\s*:([^\n]*)/;
const HEADER_REGISTERS = /(?:^|\n)\s*Registers\s*:/i;
const HEADER_TIMESTAMP = /(?:^|\n)\s*Timestamp\s*:/i;
const HEADER_PID = /(?:^|\n)\s*(?:Pid|Process)\s*:/i;
const HEADER_FAULT_THREAD = /(?:^|\n)\s*Fault thread info\s*:/i;
const HEADER_PROCESS_LIFE = /(?:^|\n)\s*Process life time\s*:/i;
const HEADER_ERROR_MESSAGE = /(?:^|\n)\s*Error message\s*:/i;
const HEADER_STACKTRACE = /(?:^|\n)\s*Stacktrace\s*:/i;
const HEADER_MSG = /(?:^|\n)\s*MSG\s*(?::|=)/i;
// Upstream lists THREAD_BLOCK_6S, APP_INPUT_BLOCK and LIFECYCLE_TIMEOUT; a system service's freeze is SERVICE_*.
const FREEZE_EVENT =
  /\b(THREAD_BLOCK_6S|THREAD_BLOCK_3S|BUSSINESS_THREAD_BLOCK_6S|BUSSINESS_THREAD_BLOCK_3S|APP_INPUT_BLOCK|LIFECYCLE_TIMEOUT|LIFECYCLE_HALF_TIMEOUT|SERVICE_BLOCK|SERVICE_WARNING|SERVICE_TIMEOUT)\b/;
const THREAD_SECTION = /(?:^|\n)\s*(?:Tid|Name)\s*:/;
const SIGNAL_REASON = /\b(SIGSEGV|SIGABRT|SIGBUS|SIGILL|SIGFPE|SIGPIPE|SIGTRAP|Signal)\b/i;
const JS_ERROR_REASON = /\b(TypeError|SyntaxError|RangeError|ReferenceError|EvalError|URIError|BusinessError|Error)\b/;
const HILOG_LINE = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+/;
/** First line of another platform's log stream (logcat). */
const OTHER_PLATFORM_LOG = /^(-+\s+beginning\s+of\s+\w+\s+-+$|\[\s*\d+-\d+\s+\d+:\d+:\d+\.\d+\s+\d+:\d+\s+\w\/)/;

const SAMPLE_STACK_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/#Basic Statistical/i, '#Basic Statistical section'],
  [/#CpuFreq Usage/i, '#CpuFreq Usage section'],
  [/#ThreadInfos\s+Tid\s*:/i, '#ThreadInfos Tid header'],
  [/(?:^|\n)\s*SnapshotTime\s*:/i, 'SnapshotTime field'],
  [/SubmitterStacktrace/, 'SubmitterStacktrace section'],
  [/(?:^|\n)\s*StaticsDuration\s*:/i, 'StaticsDuration field'],
];

interface Hit {
  kind: FaultLogFamily;
  evidence: string[];
}

function capture(text: string, pattern: RegExp): string | null {
  const value = pattern.exec(text)?.[1]?.trim();
  return value ? value : null;
}

function firstMatching(text: string, pattern: RegExp, max = 3): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (pattern.test(line)) out.push(line.trim());
    if (out.length >= max) break;
  }
  return out;
}

const threadSections = (text: string): number => text.split('\n').filter((line) => THREAD_SECTION.test(line)).length;

/** At least two header fields: the faultlog is whole, not an excerpt. */
function hasHeaderRegion(text: string): boolean {
  const patterns = [
    HEADER_REASON, HEADER_REGISTERS, HEADER_TIMESTAMP, HEADER_PID, HEADER_FAULT_THREAD,
    HEADER_PROCESS_LIFE, HEADER_ERROR_MESSAGE, HEADER_STACKTRACE, HEADER_MSG, FREEZE_EVENT,
  ];
  return patterns.filter((p) => p.test(text)).length >= 2;
}

function detectCppCrash(text: string, full: boolean): Hit | null {
  const evidence: string[] = [];
  const reason = capture(text, HEADER_REASON);
  const signal = reason !== null && SIGNAL_REASON.test(reason);
  if (signal) evidence.push(`Reason is a signal: ${reason}`);
  if (HEADER_REGISTERS.test(text)) evidence.push('Registers section present');
  if (HEADER_FAULT_THREAD.test(text)) evidence.push('Fault thread info section present');
  if (HEADER_PROCESS_LIFE.test(text)) evidence.push('Process life time field present');
  const frames = firstMatching(text, NATIVE_FRAME);
  if (frames.length > 0) evidence.push(`native frames (#NN pc <addr> <path>): ${frames.length} seen`);
  if (full) return signal && evidence.length >= 3 ? { kind: 'cpp_crash', evidence } : null;
  // A fragment is judged on positive signs only; a missing field rules nothing out.
  return frames.length > 0 ? { kind: 'cpp_crash', evidence } : null;
}

function detectJsCrash(text: string, full: boolean): Hit | null {
  const evidence: string[] = [];
  const reason = capture(text, HEADER_REASON);
  const jsReason = reason !== null && JS_ERROR_REASON.test(reason);
  if (jsReason) evidence.push(`Reason is a JS error class: ${reason}`);
  if (HEADER_ERROR_MESSAGE.test(text)) evidence.push('Error message field present');
  if (HEADER_STACKTRACE.test(text)) evidence.push('Stacktrace section present');
  const frames = firstMatching(text, JS_FRAME);
  if (frames.length > 0) evidence.push(`JS frames (at f (file:line:col)): ${frames.length} seen`);
  if (full) return jsReason && evidence.length >= 3 ? { kind: 'js_crash', evidence } : null;
  return frames.length > 0 ? { kind: 'js_crash', evidence } : null;
}

function detectAppFreeze(text: string, full: boolean): Hit | null {
  const evidence: string[] = [];
  const event = FREEZE_EVENT.exec(text)?.[1];
  if (event) evidence.push(`freeze event: ${event}`);
  if (HEADER_MSG.test(text)) evidence.push('MSG field present (main-thread queue)');
  const sections = threadSections(text);
  if (sections >= 2) evidence.push('per-thread sections (Tid/Name blocks)');
  if (full) return event && evidence.length >= 3 ? { kind: 'app_freeze', evidence } : null;
  return sections >= 2 || event ? { kind: 'app_freeze', evidence } : null;
}

function detectOutOfScope(text: string, full: boolean): FaultLogClassification['outOfScope'] | null {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return { reason: 'empty', detail: 'The input is empty.' };
  // A whole faultlog embeds a long HiLog section; that is not a log stream.
  if (full) return null;
  if (lines.filter((line) => HILOG_LINE.test(line)).length / lines.length > 0.6) {
    return { reason: 'hilog_stream', detail: 'The input is a HiLog stream, not a faultlog.' };
  }
  if (OTHER_PLATFORM_LOG.test(lines[0]!)) {
    return { reason: 'other_platform', detail: "The input is another platform's log, not an OpenHarmony faultlog." };
  }
  return null;
}

function confidenceFor(hit: Hit, full: boolean, arbitrated: boolean): FaultConfidence {
  if (!full) return arbitrated ? 'medium' : 'low';
  if (hit.kind === 'app_freeze') return hit.evidence.length >= 3 ? 'high' : 'medium';
  return hit.evidence.length >= 4 ? 'high' : 'medium';
}

function exclusionReason(kind: FaultLogFamily, text: string, full: boolean): string {
  if (!full) {
    if (kind === 'cpp_crash') return 'no native frames';
    if (kind === 'js_crash') return 'no JS frames';
    return 'no per-thread sections or freeze event';
  }
  const reason = capture(text, HEADER_REASON);
  const missing: string[] = [];
  if (kind === 'cpp_crash') {
    if (!(reason !== null && SIGNAL_REASON.test(reason))) missing.push('a signal Reason');
    if (!HEADER_REGISTERS.test(text)) missing.push('Registers');
    if (firstMatching(text, NATIVE_FRAME).length === 0) missing.push('native frames');
  } else if (kind === 'js_crash') {
    if (!(reason !== null && JS_ERROR_REASON.test(reason))) missing.push('a JS error Reason');
    if (!HEADER_ERROR_MESSAGE.test(text)) missing.push('Error message');
    if (!HEADER_STACKTRACE.test(text)) missing.push('Stacktrace');
    if (firstMatching(text, JS_FRAME).length === 0) missing.push('JS frames');
  } else {
    if (!FREEZE_EVENT.test(text)) missing.push('a freeze event');
    if (!HEADER_MSG.test(text)) missing.push('MSG');
    if (threadSections(text) < 2) missing.push('per-thread sections');
  }
  return missing.length > 0 ? `missing ${missing.join(', ')}` : 'below the threshold for a whole faultlog';
}

function excluded(hits: Hit[], full: boolean, text: string): FaultLogClassification['excluded'] {
  const present = new Set(hits.map((hit) => hit.kind));
  return FAULT_LOG_FAMILIES.filter((kind) => !present.has(kind)).map((kind) => ({ kind, reason: exclusionReason(kind, text, full) }));
}

function verdictFromHits(hits: Hit[], full: boolean, text: string): FaultLogClassification {
  const completeness: FaultCompleteness = full ? 'full' : 'fragment';
  if (hits.length === 1) {
    const hit = hits[0]!;
    const subtype = hit.kind === 'app_freeze' ? FREEZE_EVENT.exec(text)?.[1] : undefined;
    return {
      kind: hit.kind,
      ...(subtype ? { subtype } : {}),
      confidence: confidenceFor(hit, full, false),
      completeness,
      evidence: hit.evidence,
      excluded: excluded(hits, full, text),
      candidates: [],
    };
  }
  const native = hits.find((hit) => hit.kind === 'cpp_crash');
  const js = hits.find((hit) => hit.kind === 'js_crash');
  // A fragment with both native and JS frames (a mixed stack) is a native crash.
  if (native && js && !full) {
    return {
      kind: 'cpp_crash',
      confidence: 'medium',
      completeness,
      evidence: native.evidence,
      excluded: excluded(hits, full, text),
      candidates: [{ kind: 'js_crash', confidence: 'low', evidence: js.evidence, arbitrable: true }],
    };
  }
  return {
    kind: 'unknown',
    confidence: 'low',
    completeness,
    evidence: [],
    excluded: excluded(hits, full, text),
    candidates: hits.map((hit) => ({ kind: hit.kind, confidence: confidenceFor(hit, full, false), evidence: hit.evidence, arbitrable: false })),
  };
}

/**
 * Classify faultlog text by its structure alone (never by file name), so the
 * same input always gets the same answer. Order: a whole faultlog's header,
 * then sample-stack markers, then the patterns of an excerpt.
 */
export function classifyFaultLog(input: string): FaultLogClassification {
  const text = sampleText(input);
  const full = hasHeaderRegion(text);
  const outOfScope = detectOutOfScope(text, full);
  if (outOfScope) {
    return { kind: 'unknown', confidence: 'low', completeness: 'fragment', evidence: [], excluded: [], candidates: [], outOfScope };
  }
  const markers = SAMPLE_STACK_MARKERS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  const hits = [detectCppCrash(text, full), detectJsCrash(text, full), detectAppFreeze(text, full)].filter((hit): hit is Hit => hit !== null);

  if (hits.length > 0 && full) {
    const result = verdictFromHits(hits, full, text);
    if (markers.length > 0) result.evidence.push(`also has ${markers.length} sample-stack markers (supporting evidence for a freeze)`);
    return result;
  }
  // Without a whole faultlog, sample-stack markers win: its native frames are periodic snapshots, not a crash.
  if (markers.length >= 2) {
    const strong = markers.length >= 3;
    return {
      kind: 'sample_stack',
      confidence: strong ? 'high' : 'medium',
      completeness: strong ? 'full' : 'fragment',
      evidence: [`sample-stack markers: ${markers.join(', ')}`],
      excluded: [
        { kind: 'cpp_crash', reason: 'a sample stack: its native frames are periodic snapshots, not a crash' },
        { kind: 'js_crash', reason: 'a sample stack: no JS error Reason or Stacktrace' },
        { kind: 'app_freeze', reason: 'a sample stack: no freeze event or MSG; pair it with the freeze faultlog' },
      ],
      candidates: [],
    };
  }
  if (hits.length === 0) {
    return { kind: 'unknown', confidence: 'low', completeness: full ? 'full' : 'fragment', evidence: [], excluded: excluded([], full, text), candidates: [] };
  }
  return verdictFromHits(hits, full, text);
}

/**
 * Up to 512 KB is classified whole; above that, the first and last 256 KB.
 * Above {@link MAX_FAULTLOG_BYTES} the input is refused.
 */
function sampleText(input: string): string {
  const data = Buffer.from(input, 'utf8');
  if (data.length > MAX_FAULTLOG_BYTES) {
    throw new OniroError(`The faultlog is ${data.length} bytes, above the ${MAX_FAULTLOG_BYTES / 1024 / 1024} MB limit.`);
  }
  let text = input;
  if (data.length > SAMPLE_BYTES) {
    const half = SAMPLE_BYTES / 2;
    text = `${data.subarray(0, half).toString('utf8')}\n…\n${data.subarray(data.length - half).toString('utf8')}`;
  }
  text = text.replace(/\r\n?/g, '\n');
  return text.startsWith('﻿') ? text.slice(1) : text;
}
