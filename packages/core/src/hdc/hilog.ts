import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { getHdcPath } from '../sdk/paths.js';
import { shell } from './exec.js';
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
    const child = spawn(hdc, ['shell', 'hilog', '-b', opts.level]);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
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
  /** Address a specific device (`-t <serial>`). */
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
  const args: string[] = [];
  if (opts.deviceSerial) args.push('-t', opts.deviceSerial);
  args.push('shell', 'hilog');
  if (opts.processId && opts.processId.trim() !== '') {
    args.push('-P', opts.processId.trim());
  }
  if (opts.domain !== undefined && `${opts.domain}` !== '') {
    args.push('-D', `${opts.domain}`);
  }
  return spawn(hdc, args);
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

export interface WaitForLogOptions {
  config: ConfigProvider;
  /** Tested against `"<tag>: <message>"` of each parsed line. */
  pattern: RegExp;
  timeoutMs: number;
  /** Restrict to a bundle's pid (resolved via pidof; re-resolved on each reconnect). */
  bundle?: string;
  domain?: string | number;
  deviceSerial?: string;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/**
 * Resolve with the first hilog entry whose `"<tag>: <message>"` matches `pattern`.
 * The underlying stream is auto-respawned if it dies before the deadline, so the
 * wait survives a reboot mid-observation. Rejects on timeout (OniroError) or
 * abort (CancelledError).
 */
export function waitForLog(opts: WaitForLogOptions): Promise<HilogEntry> {
  return new Promise<HilogEntry>((resolve, reject) => {
    const deadline = Date.now() + opts.timeoutMs;
    let settled = false;
    let child: ChildProcessWithoutNullStreams | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let buf = '';

    const cleanup = (): void => {
      clearTimeout(timer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      if (child) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
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
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const entry = parseHilogLine(line);
          if (entry && opts.pattern.test(entryText(entry))) {
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
          reconnectTimer = setTimeout(() => void spawnStream(), 1_000);
        }
      };
      stream.once('close', onEnd);
      stream.once('error', onEnd);
    };

    void spawnStream();
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
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/** Collect all hilog entries matching `pattern` for `durationMs`. Deduped by default. */
export function watchLog(opts: WatchLogOptions): Promise<HilogEntry[]> {
  return new Promise<HilogEntry[]>((resolve, reject) => {
    const matches: HilogEntry[] = [];
    let settled = false;
    let child: ChildProcessWithoutNullStreams | null = null;
    let buf = '';

    const cleanup = (): void => {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      if (child) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
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
      const processId = await resolveProcessId(opts.config, opts.bundle, opts.deviceSerial);
      if (settled) return;
      const stream = streamHilog({ config: opts.config, processId, domain: opts.domain, deviceSerial: opts.deviceSerial });
      child = stream;
      stream.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const entry = parseHilogLine(line);
          if (entry && opts.pattern.test(entryText(entry))) matches.push(entry);
        }
      });
    })();
  });
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
    .split('\n')
    .map((line) => parseHilogLine(line))
    .filter((e): e is HilogEntry => e !== null);
}
