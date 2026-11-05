/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/faultlog/crash/stack-parser.ts`), Copyright (c) 2026
 * Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/faultlog/NOTICE.md.
 */

/** `Tid:20020, Name:com.example.app` (leading space tolerated, as in cppcrash). */
export const THREAD_HEADER_RE = /^\s*Tid:(\d+)(?:,|\s)+Name:(.*)/;

/** `#00 pc 000000000008ffec /system/lib/ld-musl-aarch64.so.1(do_dlsym+492)(f0e7…)`. */
const NATIVE_FRAME_RE = /^\s*#(\d+)\s+pc\s+([0-9a-fA-F]+)\s+(.*)$/;
/** A trailing build id: `(f0e771a679326f8feeb53b4007229578)`. */
const BUILD_ID_RE = /\(([0-9a-fA-F]{16,})\)\s*$/;
/**
 * `at parseConfig entry (entry/src/main/ets/pages/Index.ets:8:13)`, optionally
 * numbered (`#05 at …`). Devices print the module after the function name;
 * older logs and upstream's fixtures have only the function.
 */
const JS_FRAME_RE = /^\s*(?:#\d+\s+)?at\s+(.*?)\s*\((.+):(\d+):(\d+)\)\s*$/;
/** `at entry/src/main/ets/pages/Index.ets:8:13` (no function name). */
const JS_BARE_FRAME_RE = /^\s*(?:#\d+\s+)?at\s+(\S+):(\d+):(\d+)\s*$/;

/** Where a frame's code lives: the OS, the app, or something else (an anonymous mapping). */
export type FrameArea = 'system' | 'app' | 'other';

export interface NativeFrame {
  index: number;
  pc: string;
  /** Library or executable path, e.g. `/system/lib64/libace_compatible.z.so` or `[shmm]`. */
  library: string;
  /** `do_dlsym+492`, when the log has one. */
  symbol: string | null;
  buildId: string | null;
  area: FrameArea;
  /** The line as printed, trimmed. */
  raw: string;
}

export interface JsFrame {
  /** Function name (`anonymous` for lambdas), when the line has one. */
  function: string | null;
  /** Module after the function name (`entry`), when the line has one. */
  module: string | null;
  file: string;
  line: number;
  column: number;
  /** In the project's own sources (`<module>/src/main/…`), not the SDK or a dependency. */
  project: boolean;
  raw: string;
}

export type StackFrame = ({ kind: 'native' } & NativeFrame) | ({ kind: 'js' } & JsFrame);

export interface ThreadStack {
  tid: string;
  name: string;
  frames: StackFrame[];
}

function nativeArea(library: string): FrameArea {
  if (/^\/(?:root\/)?(?:system|vendor|prod|chip_prod|sys_prod)\//.test(library)) return 'system';
  if (library.includes('libarkweb_engine.so') || library === '[shmm]') return 'system';
  if (library.startsWith('/data/')) return 'app';
  return 'other';
}

/** Parse one native frame line, or `null` if it is not one. */
export function parseNativeFrame(line: string): NativeFrame | null {
  const m = NATIVE_FRAME_RE.exec(line);
  if (!m) return null;
  let rest = m[3]!.trim();
  const buildId = BUILD_ID_RE.exec(rest);
  if (buildId) rest = rest.slice(0, buildId.index).trimEnd();
  const paren = rest.indexOf('(');
  const library = paren < 0 ? rest : rest.slice(0, paren);
  let symbol: string | null = paren < 0 ? null : rest.slice(paren).trim();
  if (symbol?.startsWith('(') && symbol.endsWith(')')) symbol = symbol.slice(1, -1);
  return {
    index: Number(m[1]),
    pc: m[2]!,
    library,
    symbol: symbol || null,
    buildId: buildId?.[1] ?? null,
    area: nativeArea(library),
    raw: line.trim(),
  };
}

function isProjectFile(file: string): boolean {
  return !file.startsWith('/') && !/(?:^|[/|])(?:oh_modules|node_modules)(?:[/|]|$)/.test(file) && /(?:^|[/|])src[/|](?:main|ohosTest)[/|]/.test(file);
}

/** Parse one ArkTS/JS frame line, or `null` if it is not one. */
export function parseJsFrame(line: string): JsFrame | null {
  const m = JS_FRAME_RE.exec(line);
  if (m) {
    const [fn, ...moduleParts] = m[1]!.split(/\s+/).filter(Boolean);
    const file = m[2]!;
    return {
      function: fn ?? null,
      module: moduleParts.length > 0 ? moduleParts.join(' ') : null,
      file,
      line: Number(m[3]),
      column: Number(m[4]),
      project: isProjectFile(file),
      raw: line.trim(),
    };
  }
  const bare = JS_BARE_FRAME_RE.exec(line);
  if (!bare) return null;
  return {
    function: null,
    module: null,
    file: bare[1]!,
    line: Number(bare[2]),
    column: Number(bare[3]),
    project: isProjectFile(bare[1]!),
    raw: line.trim(),
  };
}

/** Parse a native or JS frame line. */
export function parseFrame(line: string): StackFrame | null {
  const native = parseNativeFrame(line);
  if (native) return { kind: 'native', ...native };
  const js = parseJsFrame(line);
  return js ? { kind: 'js', ...js } : null;
}

/** Split stack text at `Tid:…, Name:…` headers. A repeated tid replaces the earlier one. */
export function parseThreadStacks(lines: readonly string[]): Map<string, ThreadStack> {
  const stacks = new Map<string, ThreadStack>();
  let current: ThreadStack | null = null;
  for (const line of lines) {
    const header = THREAD_HEADER_RE.exec(line);
    if (header) {
      current = { tid: header[1]!, name: header[2]!.trim(), frames: [] };
      stacks.set(current.tid, current);
      continue;
    }
    const frame = current ? parseFrame(line) : null;
    if (frame) current!.frames.push(frame);
  }
  return stacks;
}

/** Hints for the error lines hiview writes when it could not capture a stack. */
const STACK_ERROR_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/has been crashed/, 'the process had already crashed; see the cppcrash log near this time'],
  [/SIGDUMP error/, 'the process exited before its stack was dumped'],
  [/is dumping/, 'the process was already being dumped'],
  [/State:\tS \(sleeping\)/, 'the process was sleeping when dumped'],
  [/errno\(2\)/, 'the process did not answer the dump signal and exited'],
  [/pid\(\d+\) process has exited/, 'the process had exited'],
  [/Failed to dump normal stacktrace/, 'the normal stack dump failed'],
];

/** The stack-capture error lines in a section, each with what it means (deduplicated). */
export function extractStackErrors(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const hint = STACK_ERROR_HINTS.find(([pattern]) => pattern.test(line));
    const text = line.trim();
    if (hint && !seen.has(text)) {
      seen.add(text);
      out.push(`${text} (${hint[1]})`);
    }
  }
  return out;
}
