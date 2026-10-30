import * as fs from 'node:fs';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { getHdcPath } from '../sdk/paths.js';
import { killProcessTree, spawnCompat } from './spawnCompat.js';
import { ensureOk, hdcTargetArgs, shell } from './exec.js';
import { findRunningProcess } from './app.js';

export type HilogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/** A parsed line of `hdc shell hilog` output. */
export interface HilogEntry {
  /** "MM-DD HH:MM:SS.mmm". The device timestamp; no year. */
  time: string;
  pid: string;
  tid: string;
  /** Short level letter as printed by hilog: D, I, W, E (F is rare). */
  level: 'D' | 'I' | 'W' | 'E' | 'F';
  tag: string;
  message: string;
}

export interface SetHilogLevelOptions {
  config: ConfigProvider;
  level: HilogLevel;
  deviceSerial?: string;
  logger?: Logger;
}

/**
 * Set the hilog buffer level on the connected device. Resolves when the
 * underlying `hdc shell hilog -b <LEVEL>` exits successfully; rejects with
 * the stderr text if the command fails.
 */
export function setHilogLevel(opts: SetHilogLevelOptions): Promise<void> {
  const logger = opts.logger ?? noopLogger;
  const hdc = getHdcPath(opts.config);
  return new Promise((resolve, reject) => {
    // `hdc` may be a batch wrapper on Windows (an `hdcPath` override pointing at
    // a proxy/tunnel script), which a bare spawn cannot execute — spawnCompat
    // routes those through cmd.exe. It can also throw synchronously, so the
    // failure is funnelled into the same rejection as the 'error' event below.
    let child: ChildProcess;
    try {
      child = spawnCompat(hdc, [...hdcTargetArgs(opts.deviceSerial), 'shell', 'hilog', '-b', opts.level]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[hilog] failed to spawn hdc: ${msg}`);
      reject(err instanceof Error ? err : new Error(msg));
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (err) => {
      logger.error(`[hilog] failed to spawn hdc: ${err.message}`);
      reject(err);
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = stderr.trim() || `hdc shell hilog -b ${opts.level} exited with code ${code}`;
        logger.error(`[hilog] ${msg}`);
        reject(new Error(msg));
      }
    });
  });
}

export interface StreamHilogOptions {
  config: ConfigProvider;
  /** Restrict the stream to a single process id (passed as `-P <pid>`). */
  processId?: string;
  /** Filter by hilog domain, e.g. '0xD003900' (passed as `-D <domain>`). */
  domain?: string | number;
  /** Address a specific device (`-t <serial>`); defaults to `ONIRO_DEVICE_SERIAL`. */
  deviceSerial?: string;
}

/**
 * Spawn `hdc [-t serial] shell hilog [-P <pid>] [-D <domain>]` and return the
 * child process. The caller owns the stdout/stderr streams (typically wired
 * through `parseHilogLine`) and is responsible for killing the process when
 * streaming should stop.
 */
export function streamHilog(opts: StreamHilogOptions): ChildProcessWithoutNullStreams {
  const hdc = getHdcPath(opts.config);
  const args: string[] = [...hdcTargetArgs(opts.deviceSerial)];
  args.push('shell', 'hilog');
  if (opts.processId && opts.processId.trim() !== '') {
    args.push('-P', opts.processId.trim());
  }
  if (opts.domain !== undefined && `${opts.domain}` !== '') {
    args.push('-D', `${opts.domain}`);
  }
  // Keeps the published non-null-stdio signature rather than pushing `?.` onto
  // every consumer. Sound because no stdio option is passed: both spawnCompat
  // branches inherit spawn's default `stdio: 'pipe'`, so the streams exist.
  return spawnCompat(hdc, args) as ChildProcessWithoutNullStreams;
}

// `\S+` is greedy on the tag so values like `C01406/OHOS::RS` aren't split at
// the first internal colon — the regex backtracks to the last `:` followed by
// whitespace, which is the actual tag/message separator hilog emits.
const HILOG_LINE_RE = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+(\S+):\s+(.*)$/;

/**
 * Parse a single line of `hdc shell hilog` output into structured fields.
 * Returns null when the line doesn't match the expected hilog format (e.g.
 * banners, blank lines, or partial chunks).
 */
export function parseHilogLine(line: string): HilogEntry | null {
  const match = HILOG_LINE_RE.exec(line);
  if (!match) return null;
  return {
    time: match[1]!,
    pid: match[2]!,
    tid: match[3]!,
    level: match[4]! as HilogEntry['level'],
    tag: match[5]!.trim(),
    message: match[6]!,
  };
}

/** The searchable text a pattern is tested against: `"<tag>: <message>"`. */
function entryText(e: HilogEntry): string {
  return `${e.tag}: ${e.message}`;
}

/** Collapse consecutive duplicate entries (same level/tag/message), ignoring time/pid. */
export function dedupEntries(entries: HilogEntry[]): HilogEntry[] {
  const out: HilogEntry[] = [];
  let lastKey = '';
  for (const e of entries) {
    const key = `${e.level}|${e.tag}|${e.message}`;
    if (key === lastKey) continue;
    out.push(e);
    lastKey = key;
  }
  return out;
}

/** Resolve a bundle name to its pid for `-P` filtering, or undefined if not running. */
async function resolveProcessId(
  config: ConfigProvider,
  bundle: string | undefined,
  deviceSerial?: string,
): Promise<string | undefined> {
  if (!bundle) return undefined;
  const proc = await findRunningProcess({ config, bundle, deviceSerial });
  return proc?.pid;
}

/**
 * The device's wall clock (`date`) as `Date.UTC` ms of its local time, the frame
 * hilog prints its timestamps in, to the second. Null when it can't be read.
 */
async function readDeviceClock(config: ConfigProvider, deviceSerial?: string): Promise<number | null> {
  try {
    const res = await shell({ config, command: 'date +%Y-%m-%dT%H:%M:%S', deviceSerial, timeoutMs: 10_000 });
    const m = res.code === 0 ? /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(res.stdout) : null;
    if (!m) return null;
    const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
    return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  } catch {
    return null;
  }
}

/**
 * A hilog `time` ("MM-DD HH:MM:SS.mmm", no year) as `Date.UTC` ms, in the year
 * that puts it closest to `referenceMs`, so a December 31st line read on
 * January 1st lands in the previous year. Null when `time` has another form.
 */
export function hilogTimeMs(time: string, referenceMs: number): number | null {
  const m = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(time);
  if (!m) return null;
  const [month, day, hour, minute, second, ms] = m.slice(1).map(Number);
  const year = new Date(referenceMs).getUTCFullYear();
  let best: number | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const t = Date.UTC(y, month! - 1, day!, hour!, minute!, second!, ms!);
    if (best === null || Math.abs(t - referenceMs) < Math.abs(best - referenceMs)) best = t;
  }
  return best;
}

/**
 * Build the test that keeps an entry logged no earlier than `lookbackMs` before
 * now, on the device clock. `hdc shell hilog` replays the buffer before it
 * streams, so without it a wait matches lines from minutes ago. When the clock
 * can't be read, every entry passes and a warning says so.
 */
async function recentEntryFilter(opts: {
  config: ConfigProvider;
  deviceSerial?: string;
  lookbackMs?: number;
  logger: Logger;
}): Promise<(entry: HilogEntry) => boolean> {
  const lookbackMs = opts.lookbackMs ?? 0;
  if (lookbackMs === Infinity) return () => true;
  const now = await readDeviceClock(opts.config, opts.deviceSerial);
  if (now === null) {
    opts.logger.warn('Could not read the device clock, so lines already in the log buffer can match too.');
    return () => true;
  }
  const since = now - lookbackMs;
  return (entry) => {
    const t = hilogTimeMs(entry.time, now);
    return t === null || t >= since;
  };
}

export interface WaitForLogOptions {
  config: ConfigProvider;
  /** Tested against `"<tag>: <message>"` of each parsed line. */
  pattern: RegExp;
  timeoutMs: number;
  /** Restrict to a bundle's pid (resolved via pidof; re-resolved on each reconnect). */
  bundle?: string;
  domain?: string | number;
  deviceSerial?: string;
  /**
   * Also match lines logged up to this long before the call. By default (0) only
   * lines from the call onwards count, measured on the device clock to the second.
   * `Infinity` matches everything still in the device buffer.
   */
  lookbackMs?: number;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/**
 * Resolve with the first hilog entry whose `"<tag>: <message>"` matches `pattern`
 * and that was logged since the call (see `lookbackMs`). The underlying stream is
 * auto-respawned if it dies before the deadline, so the wait survives a reboot
 * mid-observation. Rejects on timeout (OniroError) or abort (CancelledError).
 */
export function waitForLog(opts: WaitForLogOptions): Promise<HilogEntry> {
  return new Promise<HilogEntry>((resolve, reject) => {
    const deadline = Date.now() + opts.timeoutMs;
    let settled = false;
    let child: ChildProcessWithoutNullStreams | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let buf = '';
    let isRecent: (entry: HilogEntry) => boolean = () => true;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      if (child) {
        // A batch wrapper's own death would leave the hdc process it launched
        // streaming; tear down the whole tree.
        killProcessTree(child);
        child = null;
      }
    };
    const finish = (entry: HilogEntry): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(entry);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const failWith = (err: unknown): void => fail(err instanceof Error ? err : new Error(String(err)));
    const onAbort = (): void => fail(new CancelledError('waitForLog cancelled.'));
    const timer = setTimeout(
      () => fail(new OniroError(`No log line matched ${String(opts.pattern)} within ${opts.timeoutMs}ms.`)),
      opts.timeoutMs,
    );
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const spawnStream = async (): Promise<void> => {
      if (settled) return;
      const processId = await resolveProcessId(opts.config, opts.bundle, opts.deviceSerial);
      if (settled) return;
      const stream = streamHilog({ config: opts.config, processId, domain: opts.domain, deviceSerial: opts.deviceSerial });
      child = stream;
      stream.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const entry = parseHilogLine(line);
          if (entry && isRecent(entry) && opts.pattern.test(entryText(entry))) {
            finish(entry);
            return;
          }
        }
      });
      const onEnd = (): void => {
        if (settled || child !== stream) return;
        child = null;
        if (Date.now() < deadline) {
          // Auto-reconnect (survives a reboot) until the deadline.
          reconnectTimer = setTimeout(() => void spawnStream().catch(failWith), 1_000);
        }
      };
      stream.once('close', onEnd);
      stream.once('error', onEnd);
    };

    // spawnStream can reject (device lookup, or a synchronous spawn failure);
    // surface it as this promise's rejection instead of an unhandled one.
    void (async () => {
      isRecent = await recentEntryFilter({
        config: opts.config,
        deviceSerial: opts.deviceSerial,
        lookbackMs: opts.lookbackMs,
        logger: opts.logger ?? noopLogger,
      });
      await spawnStream();
    })().catch(failWith);
  });
}

export interface WatchLogOptions {
  config: ConfigProvider;
  pattern: RegExp;
  /** How long to collect matching entries. */
  durationMs: number;
  bundle?: string;
  domain?: string | number;
  deviceSerial?: string;
  /** Collapse consecutive duplicate lines. Default true. */
  dedup?: boolean;
  /** Also collect lines logged up to this long before the call; see {@link WaitForLogOptions.lookbackMs}. */
  lookbackMs?: number;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/**
 * Collect the hilog entries matching `pattern` that are logged during `durationMs`
 * (see `lookbackMs`). Deduped by default.
 */
export function watchLog(opts: WatchLogOptions): Promise<HilogEntry[]> {
  return new Promise<HilogEntry[]>((resolve, reject) => {
    const matches: HilogEntry[] = [];
    let settled = false;
    let child: ChildProcessWithoutNullStreams | null = null;
    let buf = '';
    let isRecent: (entry: HilogEntry) => boolean = () => true;

    const cleanup = (): void => {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      if (child) {
        // A batch wrapper's own death would leave the hdc process it launched
        // streaming; tear down the whole tree.
        killProcessTree(child);
        child = null;
      }
    };
    const done = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(opts.dedup === false ? matches : dedupEntries(matches));
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CancelledError('watchLog cancelled.'));
    };
    const timer = setTimeout(done, opts.durationMs);
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

    void (async () => {
      isRecent = await recentEntryFilter({
        config: opts.config,
        deviceSerial: opts.deviceSerial,
        lookbackMs: opts.lookbackMs,
        logger: opts.logger ?? noopLogger,
      });
      if (settled) return;
      const processId = await resolveProcessId(opts.config, opts.bundle, opts.deviceSerial);
      if (settled) return;
      const stream = streamHilog({ config: opts.config, processId, domain: opts.domain, deviceSerial: opts.deviceSerial });
      child = stream;
      stream.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const entry = parseHilogLine(line);
          if (entry && isRecent(entry) && opts.pattern.test(entryText(entry))) matches.push(entry);
        }
      });
      // A device lookup or synchronous spawn failure used to surface as an
      // unhandled rejection while watchLog quietly resolved empty at the deadline.
    })().catch((err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export interface CaptureLogOptions {
  config: ConfigProvider;
  /** File the hilog lines are appended to. */
  file: string;
  /** Stop after this long. Default: run until `abortSignal` fires. */
  durationMs?: number;
  /** Keep only the lines this matches. Default: every line. */
  pattern?: RegExp;
  /** Clear the device's log buffer first (`hilog -r`), so the file covers only this session. */
  clear?: boolean;
  domain?: string | number;
  deviceSerial?: string;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

export interface CaptureLogResult {
  file: string;
  /** Lines written to `file`. */
  lines: number;
  /** How many times the stream dropped and was respawned. */
  reconnects: number;
}

/**
 * Stream hilog into `file` until `durationMs` passes or `abortSignal` fires. The
 * device's log buffer is small (256 KB per type by default) and chatty components
 * such as ArkWeb wrap it within seconds, so a dump taken at the end of a session
 * loses its start; a capture running throughout does not. Each chunk is written
 * synchronously, so killing the process keeps what was captured. The stream is
 * respawned when it drops (a reboot, a lost connection). Resolves at the deadline
 * or on abort.
 */
export async function captureLog(opts: CaptureLogOptions): Promise<CaptureLogResult> {
  const logger = opts.logger ?? noopLogger;
  if (opts.clear) {
    const res = await shell({ config: opts.config, command: 'hilog -r', deviceSerial: opts.deviceSerial, timeoutMs: 10_000, logger });
    ensureOk(res, 'hdc shell hilog -r');
  }
  const fd = fs.openSync(opts.file, 'a');
  let lines = 0;
  let reconnects = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = opts.durationMs !== undefined ? Date.now() + opts.durationMs : Infinity;
      let settled = false;
      let child: ChildProcessWithoutNullStreams | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let buf = '';
      // Cleared once the capture ends: the killed stream can still emit a chunk,
      // which must not reach the file descriptor closed below.
      let open = true;

      const write = (line: string): void => {
        if (!open || (opts.pattern && !opts.pattern.test(line))) return;
        fs.writeSync(fd, `${line}\n`);
        lines++;
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        opts.abortSignal?.removeEventListener('abort', finish);
        if (buf.trim()) write(buf.trimEnd());
        buf = '';
        open = false;
        if (child) {
          child.stdout.removeAllListeners('data');
          killProcessTree(child);
          child = null;
        }
      };
      function finish(): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = opts.durationMs !== undefined ? setTimeout(finish, opts.durationMs) : undefined;
      if (opts.abortSignal?.aborted) {
        finish();
        return;
      }
      opts.abortSignal?.addEventListener('abort', finish, { once: true });

      const spawnStream = (): void => {
        if (settled) return;
        const stream = streamHilog({ config: opts.config, domain: opts.domain, deviceSerial: opts.deviceSerial });
        child = stream;
        stream.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? '';
          for (const line of parts) write(line);
        });
        const onEnd = (): void => {
          if (settled || child !== stream) return;
          child = null;
          if (Date.now() >= deadline) return;
          reconnects++;
          logger.warn(`[hilog] stream ended; reconnecting (${reconnects}).`);
          reconnectTimer = setTimeout(() => {
            try {
              spawnStream();
            } catch (err) {
              fail(err);
            }
          }, 2_000);
        };
        stream.once('close', onEnd);
        stream.once('error', onEnd);
      };
      spawnStream();
    });
  } finally {
    fs.closeSync(fd);
  }
  return { file: opts.file, lines, reconnects };
}

export interface DumpLogOptions {
  config: ConfigProvider;
  /** Cap the result to the last N lines (device-side `tail -n`). */
  lines?: number;
  /** Restrict to a bundle's running pid (no output if it isn't running). */
  bundle?: string;
  /** Extended-regex string applied device-side via `grep -E`. */
  grep?: string;
  domain?: string | number;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * One-shot `hilog -x` dump, optionally filtered by domain, bundle pid, and a
 * grep regex, capped to the last `lines`. Mirrors the proven MCP get_logs
 * pipeline. Returns parsed entries.
 */
export async function dumpLog(opts: DumpLogOptions): Promise<HilogEntry[]> {
  let pipe = 'hilog -x';
  if (opts.domain !== undefined && `${opts.domain}` !== '') pipe += ` -D ${opts.domain}`;
  if (opts.bundle) {
    const proc = await findRunningProcess({ config: opts.config, bundle: opts.bundle, deviceSerial: opts.deviceSerial });
    if (!proc) return [];
    pipe += ` | grep -E '\\b${proc.pid}\\b'`;
  }
  if (opts.grep) {
    const safeGrep = opts.grep.replace(/'/g, `'\\''`);
    pipe += ` | grep -E '${safeGrep}'`;
  }
  if (opts.lines && opts.lines > 0) pipe += ` | tail -n ${Math.floor(opts.lines)}`;

  const res = await shell({
    config: opts.config,
    command: pipe,
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 30_000,
    logger: opts.logger,
  });
  return res.stdout
    .split(/\r?\n/)
    .map((line) => parseHilogLine(line))
    .filter((e): e is HilogEntry => e !== null);
}
