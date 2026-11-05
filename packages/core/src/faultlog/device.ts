import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shell } from '../hdc/exec.js';
import type { ConfigProvider } from '../ports/config.js';
import { OniroError } from '../ports/errors.js';
import type { Logger } from '../ports/logger.js';
import { analyzeFaultLog, type CrashVerdict } from './verdict.js';

/** Where hiview keeps faultlogs. */
export const FAULTLOG_DIR = '/data/log/faultlog/faultlogger';
/** Where faultloggerd leaves native crash records (`cppcrash-<pid>-<epoch ms>.json`). */
export const FAULTLOG_TEMP_DIR = '/data/log/faultlog/temp';

/** `hidumper -s 1201` is hiview; `-p Faultlogger` its faultlog plugin. */
export const faultloggerCommand = (args: string): string => `hidumper -s 1201 -a '-p Faultlogger ${args}'`;

export interface FaultLogEntry {
  /** File name, e.g. `jscrash-com.example.app-20010043-20261105123257298.log`. */
  name: string;
  /** Path on the device. */
  path: string;
  /** `faultlogger`: a hiview faultlog; `temp`: a faultloggerd crash record hiview has not (or will not) turn into one. */
  source: 'faultlogger' | 'temp';
  /** The file-name prefix: `cppcrash`, `jscrash`, `appfreeze`, `sysfreeze`, `syswarning`, … */
  type: string;
  /** Bundle or process name. */
  module: string | null;
  pid: number | null;
  uid: number | null;
  /** Device-local time of the fault, `YYYY-MM-DD HH:MM:SS.mmm`. */
  time: string | null;
  /** The fault's instant, when known: always for a crash record, for a faultlog when the device's UTC offset was read. */
  epochMs: number | null;
}

export interface FaultLogDeviceOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export interface ListFaultLogsOptions extends FaultLogDeviceOptions {
  /** Only entries of this bundle (exact module/process name). */
  bundle?: string;
  /** Only entries since this instant, or since this many seconds before the device's clock now. */
  since?: Date | number;
  /** Also list faultloggerd's native crash records that have no faultlog. Default true. */
  includeCrashRecords?: boolean;
}

const LOG_NAME_RE = /^([a-z]+)-(.+)-(\d+)-(\d{14})(\d{0,3})(?:\.log)?$/;
const RECORD_NAME_RE = /^cppcrash-(\d+)-(\d{13})\.json$/;
const SAFE_NAME_RE = /^[A-Za-z0-9._@+-]+$/;

/** The file names between the `******` lines of `hidumper … -p Faultlogger -l`, or null if the output is not a list. */
export function parseFaultLogList(stdout: string): string[] | null {
  const lines = stdout.replace(/\r/g, '').split('\n');
  const at = lines.findIndex((line) => line.trim() === 'Fault log list:');
  if (at < 0) return null;
  const names: string[] = [];
  let inside = false;
  for (const line of lines.slice(at + 1)) {
    const t = line.trim();
    if (/^\*{3,}$/.test(t)) {
      if (inside) break;
      inside = true;
      continue;
    }
    if (inside && t) names.push(t);
  }
  return names;
}

const fmtStamp = (d: string, ms: string): string =>
  `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}.${ms.padEnd(3, '0')}`;

/**
 * Read `<type>-<module>-<uid>-<yyyyMMddHHmmss[SSS]>.log`. `utcOffsetMinutes`
 * (the device's) turns the local time into `epochMs`.
 */
export function parseFaultLogName(name: string, utcOffsetMinutes?: number): FaultLogEntry | null {
  const m = LOG_NAME_RE.exec(name);
  if (!m) return null;
  const [, type, module, uid, digits, ms] = m as unknown as [string, string, string, string, string, string];
  let epochMs: number | null = null;
  if (utcOffsetMinutes !== undefined) {
    const local = Date.UTC(+digits.slice(0, 4), +digits.slice(4, 6) - 1, +digits.slice(6, 8), +digits.slice(8, 10), +digits.slice(10, 12), +digits.slice(12, 14), +(ms.padEnd(3, '0')));
    epochMs = local - utcOffsetMinutes * 60_000;
  }
  return {
    name,
    path: `${FAULTLOG_DIR}/${name}`,
    source: 'faultlogger',
    type,
    module,
    pid: null,
    uid: Number(uid),
    time: fmtStamp(digits, ms),
    epochMs,
  };
}

/** `+0100` → 60. */
export function parseUtcOffset(value: string): number | null {
  const m = /([+-])(\d{2}):?(\d{2})/.exec(value);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Parse the `== <path>` / head-of-file blocks the crash-record listing prints. */
export function parseCrashRecordHeads(stdout: string): FaultLogEntry[] {
  const out: FaultLogEntry[] = [];
  for (const block of stdout.replace(/\r/g, '').split(/^== /m).slice(1)) {
    const nl = block.indexOf('\n');
    const file = (nl < 0 ? block : block.slice(0, nl)).trim();
    const head = nl < 0 ? '' : block.slice(nl + 1);
    const name = file.slice(file.lastIndexOf('/') + 1);
    const m = RECORD_NAME_RE.exec(name);
    if (!m) continue;
    const str = (key: string): string | null => new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(head)?.[1]?.replace(/\\n/g, '').trim() || null;
    const num = (key: string): number | null => {
      const v = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(head)?.[1];
      return v === undefined ? null : Number(v);
    };
    out.push({
      name,
      path: `${FAULTLOG_TEMP_DIR}/${name}`,
      source: 'temp',
      type: 'cppcrash',
      module: str('PNAME'),
      pid: num('PID') ?? Number(m[1]),
      uid: num('UID'),
      time: str('TIMESTAMP'),
      epochMs: Number(m[2]),
    });
  }
  return out;
}

async function deviceClock(opts: FaultLogDeviceOptions): Promise<{ nowMs: number; offsetMinutes: number } | null> {
  const res = await shell({ ...opts, command: "date '+%s %z'", timeoutMs: opts.timeoutMs ?? 10_000 });
  const m = /^\s*(\d+)\s+(\S+)/.exec(res.stdout);
  const offset = m ? parseUtcOffset(m[2]!) : null;
  return m && offset !== null ? { nowMs: Number(m[1]) * 1000, offsetMinutes: offset } : null;
}

/**
 * List faultlogs on the device, newest first: hiview's (`hidumper -s 1201 -a
 * '-p Faultlogger -LogSuffixWithMs'`, else `ls` of {@link FAULTLOG_DIR}) and,
 * unless turned off, faultloggerd's native crash records that hiview never
 * turned into a faultlog.
 */
export async function listFaultLogs(opts: ListFaultLogsOptions): Promise<FaultLogEntry[]> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const run = (command: string): ReturnType<typeof shell> => shell({ ...opts, command, timeoutMs });
  const clock = await deviceClock(opts);
  if (opts.since !== undefined && !clock) throw new OniroError('Could not read the device clock to apply --since.');

  const listed = await run(faultloggerCommand('-LogSuffixWithMs'));
  let names = parseFaultLogList(listed.stdout);
  if (names === null) {
    opts.logger?.debug(`hidumper Faultlogger listing unavailable; listing ${FAULTLOG_DIR}`);
    const ls = await run(`ls ${FAULTLOG_DIR}`);
    names = ls.code === 0 ? ls.stdout.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.log')) : [];
  }
  const logs = names
    .map((name) => parseFaultLogName(name, clock?.offsetMinutes))
    .filter((e): e is FaultLogEntry => e !== null);

  let records: FaultLogEntry[] = [];
  if (opts.includeCrashRecords !== false) {
    const heads = await run(`for f in ${FAULTLOG_TEMP_DIR}/cppcrash-*.json; do [ -f "$f" ] && echo "== $f" && head -c 512 "$f" && echo; done`);
    // A record hiview did turn into a faultlog has the same process and time as that faultlog.
    const known = new Set(logs.filter((e) => e.type === 'cppcrash').map((e) => `${e.module}|${e.time}`));
    records = parseCrashRecordHeads(heads.stdout).filter((r) => !known.has(`${r.module}|${r.time}`));
  }

  const sinceMs = opts.since === undefined
    ? undefined
    : opts.since instanceof Date ? opts.since.getTime() : clock!.nowMs - opts.since * 1000;
  return [...logs, ...records]
    .filter((e) => !opts.bundle || e.module === opts.bundle)
    .filter((e) => sinceMs === undefined || (e.epochMs !== null && e.epochMs >= sinceMs))
    .sort((a, b) => (b.epochMs ?? 0) - (a.epochMs ?? 0) || (b.time ?? '').localeCompare(a.time ?? ''));
}

/** Drop the `[ability]` / `HiviewService` banner hidumper prints before the file. */
export function stripHidumperBanner(stdout: string): string {
  const text = stdout.replace(/\r\n/g, '\n');
  const m = /^-+HiviewService-+\n/m.exec(text);
  return m ? text.slice(m.index + m[0].length) : text;
}

export interface ReadFaultLogOptions extends FaultLogDeviceOptions {
  entry: FaultLogEntry;
}

/** The whole faultlog (or crash record) as text: `hidumper … -f <name>`, else `cat`. */
export async function readFaultLog(opts: ReadFaultLogOptions): Promise<string> {
  const { entry } = opts;
  if (!SAFE_NAME_RE.test(entry.name)) throw new OniroError(`Not a faultlog name: ${entry.name}`);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (entry.source === 'faultlogger') {
    const res = await shell({ ...opts, command: faultloggerCommand(`-f ${entry.name}`), timeoutMs });
    const text = stripHidumperBanner(res.stdout);
    if (res.code === 0 && /^\s*(?:Generated by|Device info:|Module name:)/.test(text)) return text;
  }
  const dir = entry.source === 'temp' ? FAULTLOG_TEMP_DIR : FAULTLOG_DIR;
  const res = await shell({ ...opts, command: `cat ${dir}/${entry.name}`, timeoutMs });
  if (res.code !== 0 || !res.stdout.trim() || /No such file|Permission denied/.test(res.stdout.slice(0, 200))) {
    throw new OniroError(`Could not read ${dir}/${entry.name}: ${(res.stderr || res.stdout).trim().slice(0, 200)}`);
  }
  return res.stdout.replace(/\r\n/g, '\n');
}

export interface LatestCrashOptions extends FaultLogDeviceOptions {
  /** Bundle to look for; any process when unset. */
  bundle?: string;
  /** Only faults since this instant, or since this many seconds before the device's clock now. */
  since?: Date | number;
  /**
   * Keep looking this long (ms) when nothing is found yet: hiview writes a
   * faultlog a moment after the process dies. Default 0 (look once).
   */
  waitMs?: number;
  /** Poll interval while waiting. Default 1000. */
  pollMs?: number;
  /** Save the whole faultlog in this directory and report it as `rawPath`. */
  saveDir?: string;
}

/**
 * The newest fault of `bundle` (since `since`) on the device, classified and
 * parsed, or null when there is none. Considers faultlogs of every kind and
 * native crash records hiview did not turn into one.
 */
export async function latestCrash(opts: LatestCrashOptions): Promise<CrashVerdict | null> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  // "N seconds ago" is fixed against the device's clock once, so the window does
  // not slide forward while polling.
  let since = opts.since;
  if (typeof since === 'number') {
    const clock = await deviceClock(opts);
    if (!clock) throw new OniroError('Could not read the device clock to apply --since.');
    since = new Date(clock.nowMs - since * 1000);
  }
  for (;;) {
    const [entry] = await listFaultLogs({ ...opts, since });
    if (entry) {
      const text = await readFaultLog({ ...opts, entry });
      let rawPath: string | undefined;
      if (opts.saveDir) {
        await fs.mkdir(opts.saveDir, { recursive: true });
        rawPath = path.join(opts.saveDir, entry.name);
        await fs.writeFile(rawPath, text, 'utf8');
      }
      const verdict = analyzeFaultLog(text, { name: entry.name, path: entry.path, rawPath });
      verdict.bundle ??= entry.module;
      verdict.pid ??= entry.pid;
      verdict.time ??= entry.time;
      return verdict;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(opts.pollMs ?? 1000, Math.max(0, deadline - Date.now()))));
  }
}
