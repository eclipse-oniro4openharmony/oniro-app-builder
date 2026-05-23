import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { getHdcPath } from '../sdk/paths.js';

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
}

/**
 * Spawn `hdc shell hilog [-P <pid>]` and return the child process. The caller
 * owns the stdout/stderr streams (typically wired through `parseHilogLine`) and
 * is responsible for killing the process when streaming should stop.
 */
export function streamHilog(opts: StreamHilogOptions): ChildProcessWithoutNullStreams {
  const hdc = getHdcPath(opts.config);
  const args = ['shell', 'hilog'];
  if (opts.processId && opts.processId.trim() !== '') {
    args.push('-P', opts.processId.trim());
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
