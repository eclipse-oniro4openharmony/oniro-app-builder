/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/faultlog/crash/cppcrash-parser.ts`, `crash/jserror-parser.ts`,
 * `crash/freeze-parser.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/faultlog/NOTICE.md.
 */
import { parseBinder, type BinderInfo } from './binder.js';
import { extractStackErrors, parseFrame, parseThreadStacks, THREAD_HEADER_RE, type StackFrame, type ThreadStack } from './frames.js';
import { findSection, lastSegment, searchFields, splitByMarkers } from './text.js';

// ---------------------------------------------------------------- cppcrash

const CPP_SECTION_MARKERS = [
  'Fault thread info:', 'Registers:', 'Other thread info:', 'Memory near registers:', 'FaultStack:', 'Maps:', 'OpenFiles:', 'HiLog:',
];

const CPP_HEADER = {
  module: /Module name:(.*)/,
  version: /^\s*Version:(.*)/,
  pid: /^\s*Pid:(.*)/,
  uid: /^\s*Uid:(.*)/,
  process: /Process name:(.*)/,
  lifetime: /Process life time:(.*)/,
  timestamp: /Timestamp:(.*)/,
  reason: /^\s*Reason:(.*)/,
  lastFatalMessage: /LastFatalMessage:(.*)/,
} as const;

export interface CppCrashLog {
  header: Partial<Record<keyof typeof CPP_HEADER, string>>;
  /** The first thread of `Fault thread info:`. */
  faultThread: ThreadStack | null;
  /** The GWP-ASan report, from its banner to its end marker. */
  gwpAsan: string;
}

export function parseCppCrash(lines: readonly string[]): CppCrashLog {
  const sections = splitByMarkers(lines, CPP_SECTION_MARKERS);
  const threads = parseThreadStacks(sections.get('Fault thread info:') ?? []);
  const start = lines.findIndex((line) => line.includes('*** GWP-ASan detected a memory error ***'));
  let gwpAsan = '';
  if (start >= 0) {
    const end = lines.findIndex((line, i) => i >= start && line.includes('* End GWP-ASan report *'));
    gwpAsan = lines.slice(start, end < 0 ? lines.length : end + 1).join('\n').replace(/\n+$/, '');
  }
  return {
    header: searchFields(sections.get('') ?? [], CPP_HEADER),
    faultThread: threads.values().next().value ?? null,
    gwpAsan,
  };
}

// ---------------------------------------------------------------- jscrash

const JS_HEADER = {
  module: /Module name:(.*)/,
  process: /Process name:(.*)/,
  package: /Package name:(.*)/,
  version: /^\s*Version:(.*)/,
  pid: /^\s*Pid:(.*)/,
  uid: /^\s*Uid:(.*)/,
  faultTime: /Fault time:(.*)/,
  timestamp: /Timestamp:(.*)/,
  reason: /^\s*Reason:(.*)/,
  errorName: /Error name:(.*)/,
  errorMessage: /Error message:(.*)/,
  errorCode: /Error code:(.*)/,
} as const;

export interface JsCrashLog {
  header: Partial<Record<keyof typeof JS_HEADER, string>>;
  faultTid: string;
  faultThreadName: string;
  /** The `Stacktrace:` section, one frame per line as printed. */
  stack: string[];
  /** The same frames, parsed. */
  frames: StackFrame[];
  /** The `HybridStack:` section (native and JS frames interleaved), when present. */
  hybrid: StackFrame[];
}

/** Frames from a `<title>:` line to the first non-empty line that is not a frame. */
function framesAfter(lines: readonly string[], title: string): string[] {
  const start = lines.findIndex((line) => line.trim() === title);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!parseFrame(line)) break;
    out.push(line.trim());
  }
  return out;
}

export function parseJsCrash(lines: readonly string[]): JsCrashLog {
  const header = searchFields(lines, JS_HEADER);
  const thread = lines.map((line) => THREAD_HEADER_RE.exec(line)).find((m) => m !== null);
  const stack = framesAfter(lines, 'Stacktrace:');
  return {
    header,
    faultTid: thread?.[1] ?? '',
    faultThreadName: thread?.[2]?.trim() ?? '',
    stack,
    frames: stack.map((line) => parseFrame(line)!),
    hybrid: framesAfter(lines, 'HybridStack:').map((line) => parseFrame(line)!),
  };
}

// ---------------------------------------------------------------- appfreeze

/** Ends the header, and separates the warning report from the block report. */
const SEPARATOR_RE = /^\*{3,}\s*$/;
/** Where the faulting process's stacks end (before the binder peers' stacks). */
const STACK_END_RE = /Catche stack trace end time:|BinderCatcher --|PeerBinderCatcher|^-{5,}\s*$/;
const STACK_START_RE = /^Tid:\d+(?:,|\s)+Name:/;

const FREEZE_HEADER = {
  module: /Module name:(.*)/,
  reason: /^\s*Reason:(.*)/,
  process: /(?:PROCESS_NAME|Process name):(.*)/,
  pid: /(?:PID = |Pid:|pid=)(.*)/,
} as const;

const FREEZE_MSG = {
  eventName: /EVENTNAME = (.*)/,
  timestamp: /TIMESTAMP = (.*)/,
  pid: /(?:PID = |Pid:|pid=)(.*)/,
  tid: /(?:TID = |Tid:|tid=)(.*)/,
  process: /(?:PROCESS_NAME = |PROCESS_NAME:)(.*)/,
  msg: /MSG =(.*)/,
  faultTime: /Fault time:(.*)/,
} as const;

export interface FreezeReport {
  msg: Partial<Record<keyof typeof FREEZE_MSG, string>>;
  stacks: Map<string, ThreadStack>;
  stackErrors: string[];
}

export interface FreezeLog {
  header: Partial<Record<keyof typeof FREEZE_HEADER, string>>;
  /** The header's Reason, else the event name. */
  reason: string;
  /** The first report (warning). */
  warning: FreezeReport;
  /** The second report (block), taken a few seconds later, when present. */
  block: FreezeReport | null;
  binder: BinderInfo;
  /** tid of the FFRT worker running the blocked queue task, when there is one. */
  ffrtTid: string;
  /** pid → process name, for labelling binder nodes. */
  processNames: Map<string, string>;
  pid: string;
  process: string;
  /** The blocked thread: the FFRT worker when the queue is blocked, else the reported TID, else the main thread. */
  faultTid: string;
}

function parseReport(lines: readonly string[]): FreezeReport {
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && lines[i]!.includes('start time:')) start = i;
    if (lines[i]!.includes('MSG =')) {
      end = i + 2;
      break;
    }
  }
  const [stackLines] = findSection(lines, STACK_START_RE, STACK_END_RE);
  return {
    msg: start >= 0 && end >= 0 ? searchFields(lines.slice(start, end), FREEZE_MSG) : {},
    stacks: parseThreadStacks(stackLines),
    stackErrors: extractStackErrors(stackLines),
  };
}

/** `--[cpuusage]--` rows: pid → process name. */
function cpuProcessNames(lines: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  const [section] = findSection(lines, /--\[cpuusage\]--/, /cpuusage end time:/);
  for (const line of section) {
    const m = /\s+(\d+)\s+(\d+\.\d+)%\s+\d+\.\d+%\s+\d+\.\d+%\s+\d+\s+\d+\s+(.*)/.exec(line);
    if (m && !names.has(m[1]!)) names.set(m[1]!, lastSegment(m[3]!.trim()));
  }
  return names;
}

export function parseFreeze(lines: readonly string[]): FreezeLog {
  const headerEnd = lines.findIndex((line) => line.includes('start time:'));
  const header = searchFields(headerEnd < 0 ? lines : lines.slice(0, headerEnd), FREEZE_HEADER);
  const separators = lines.flatMap((line, i) => (SEPARATOR_RE.test(line) ? [i] : []));
  const split = separators[1];
  const warning = parseReport(split === undefined ? lines : lines.slice(0, split));
  const block = split === undefined ? null : parseReport(lines.slice(split));
  const [ffrt] = findSection(lines, /FfrtCallback:|FfrtCatcher -- start time/, /FfrtCatcher -- end time/);
  const ffrtTid = ffrt.map((line) => /worker tid (\d+) queue task is running/.exec(line)?.[1]).find(Boolean) ?? '';
  const binder = parseBinder(lines);
  const pid = warning.msg.pid || header.pid || '';
  const process = warning.msg.process || header.process || header.module || '';
  const processNames = cpuProcessNames(lines);
  for (const [peerPid, name] of binder.peers) if (name) processNames.set(peerPid, lastSegment(name));
  if (pid && process) processNames.set(pid, lastSegment(process));
  return {
    header,
    reason: header.reason || warning.msg.eventName || '',
    warning,
    block,
    binder,
    ffrtTid,
    processNames,
    pid,
    process,
    faultTid: ffrtTid || warning.msg.tid || pid,
  };
}
