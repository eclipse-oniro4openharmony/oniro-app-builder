import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { shell } from '../hdc/exec.js';
import { recvFile } from '../hdc/files.js';
import { selectDevice } from '../hdc/devices.js';
import { getDisplaySize } from '../hdc/display.js';
import { paramGet } from '../hdc/param.js';
import { getImeBundles } from '../hdc/ime.js';
import { dumpLayout, findCoveredNodes, pruneLayout, type LayoutNode, type RawLayoutNode } from '../hdc/dump.js';
import { holdScreenOn, wakeAndUnlock } from '../hdc/power.js';
import { streamHilog } from '../hdc/hilog.js';
import { killProcessTree } from '../hdc/spawnCompat.js';
import { flowFromRecording, parseUiRecordLines, type FlowFromRecordingResult, type RecordingTimes } from './recording.js';

/** Where `uitest uiRecord record` writes its events on the device (fixed by uitest). */
export const UI_RECORD_CSV = '/data/local/tmp/record.csv';
// The recorder's console output (it prints each event and where it saved each layout).
const RECORD_CONSOLE = '/data/local/tmp/oniro_record_console.txt';
// hilog domain of the multimodal input server (`C02801/ServerMsgHandler`), which logs every touch-down.
const MMI_SERVER_DOMAIN = '0xD002801';

export interface RecordFlowOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  logger?: Logger;
  /** Stop after this long, ms. */
  durationMs?: number;
  /** Stop when this aborts (Ctrl+C). Recording runs until one of the two. */
  abortSignal?: AbortSignal;
  /** The app being recorded; default: the foreground app when recording starts. */
  bundle?: string;
  /**
   * Turn the screen on, swipe away a lock screen without a credential, and keep
   * the screen on while recording (restored afterwards). Default true.
   */
  wake?: boolean;
  /** Called when the recorder has written more events (raw lines, two per keystroke). */
  onEvents?: (count: number) => void;
  /** How often to poll the recorder, ms. Default 1000. */
  pollMs?: number;
  /**
   * Keep uitest's raw recording here: `record.csv`, the layout files, the
   * recorder's console, and `recording.json` (display, IME bundles, touch and
   * layout times, the layouts dumped before and after). For bug reports.
   */
  rawDir?: string;
}

export interface RecordFlowResult extends FlowFromRecordingResult {
  /** The raw event lines uitest wrote. */
  events: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * A device timestamp as `date '+%Y-%m-%d %H:%M:%S.%N %z'` and `stat -c %y` print it
 * (`2026-11-05 14:37:23.885001099 +0100`), in epoch ms; undefined when it does not parse. Pure.
 */
export function parseDeviceTime(text: string): number | undefined {
  const m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*([+-]\d{2}):?(\d{2})/.exec(text);
  if (!m) return undefined;
  const ms = (m[3] ?? '0').padEnd(3, '0').slice(0, 3);
  const t = Date.parse(`${m[1]}T${m[2]}.${ms}${m[4]}:${m[5]}`);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * The touch-down times in `hilog -x` output: the multimodal input service logs
 * `ServerMsgHandler: [P:D:<id>|…]` for each finger going down. hilog prints local
 * time without a year or zone, so `reference` (a {@link parseDeviceTime} string
 * from the device) supplies them. Only touches at or after `since` (epoch ms) count. Pure.
 */
export function parseTouchDowns(hilog: string, reference: string, since = 0): number[] {
  const ref = /(\d{4})-\d{2}-\d{2}[ T][\d:.]+\s*([+-]\d{2}:?\d{2})/.exec(reference);
  if (!ref) return [];
  const out: number[] = [];
  for (const line of hilog.split(/\r?\n/)) {
    // `11-05 14:42:00.689  2401  2694 I C02801/ServerMsgHandler: [P:D:2138|334]…`; the tag must be the
    // line's own, not text inside another line (hdc logs the shell command that greps for it).
    const m = /^(\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\d+\s+\d+\s+[A-Z]\s+[^\s/]+\/ServerMsgHandler: \[P:D:/.exec(line.trim());
    if (!m) continue;
    const t = parseDeviceTime(`${ref[1]}-${m[1]} ${m[2]} ${ref[2]}`);
    if (t !== undefined && t >= since) out.push(t);
  }
  return out;
}

/** `Current ForAbility :com.example.app, EntryAbility` from the recorder's console. Pure. */
export function parseRecorderForeground(consoleText: string): { bundle: string; ability: string } | undefined {
  const m = /Current ForAbility\s*:\s*([^,\s]+)\s*,\s*(\S+)/.exec(consoleText);
  return m ? { bundle: m[1]!, ability: m[2]! } : undefined;
}

/**
 * Record a flow with uitest's own recorder: run `uitest uiRecord record -l` in
 * the background on the device (it logs every touch and key, with the widget
 * under the finger, and dumps the layout for each), stop it with SIGINT after
 * `durationMs` or when `abortSignal` aborts, then pull its event file and
 * layouts and turn them into a flow ({@link flowFromRecording}). uitest writes
 * an event only once the next touch has started, so the multimodal input
 * service's hilog domain is followed meanwhile for the touch-down times, and the
 * layouts' modification times place them on the same clock. A layout dumped
 * just before starting and one just after stopping bracket the session. Events
 * made by `input` (uitest uiInput) are recorded too. While the recorder runs,
 * `uitest dumpLayout` blocks for everyone using the device.
 */
export async function recordFlow(opts: RecordFlowOptions): Promise<RecordFlowResult> {
  const { config } = opts;
  const logger = opts.logger ?? noopLogger;
  const deviceSerial = await selectDevice(config, opts.deviceSerial, { logger });
  const run = (command: string, timeoutMs = 15_000) => shell({ config, command, deviceSerial, timeoutMs, logger });

  let restoreScreen: (() => Promise<void>) | undefined;
  let pid: number | undefined;
  let touchLog: ChildProcessWithoutNullStreams | undefined;
  let touchText = '';
  try {
    if (opts.wake !== false) {
      const screen = await wakeAndUnlock({ config, deviceSerial, logger });
      if (screen.locked) throw new OniroError('The lock screen asks for a credential; unlock the device before recording.');
      restoreScreen = await holdScreenOn({ config, deviceSerial, ms: Math.min(opts.durationMs ?? 1_800_000, 1_800_000) });
    }
    const display = await getDisplaySize(config, { deviceSerial, logger });
    if (!display) throw new OniroError('Could not read the display size of the device.');
    const apiText = await paramGet(config, 'const.ohos.apiversion', { deviceSerial }).catch(() => '');
    const api = /^\d+$/.test(apiText.trim()) ? Number(apiText.trim()) : undefined;
    const imeBundles = await getImeBundles(config, { deviceSerial, logger });
    const startedAt = (await run(`date '+%Y-%m-%d %H:%M:%S.%N %z'`)).stdout.trim();
    const initialTime = parseDeviceTime(startedAt);
    const initial = (await dumpLayout({ config, deviceSerial, logger })).tree;

    // The multimodal input service logs each touch-down; follow its hilog domain while recording
    // (reading the buffer afterwards misses touches: it rotates within seconds on a busy device).
    touchLog = streamHilog({ config, deviceSerial, domain: MMI_SERVER_DOMAIN });
    touchLog.stdout.setEncoding('utf8');
    touchLog.stdout.on('data', (chunk: string) => {
      touchText += chunk;
    });
    touchLog.on('error', () => undefined);
    // An earlier session's record.csv must not be read back as this one's.
    await run(`rm -f ${UI_RECORD_CSV} ${RECORD_CONSOLE}`);
    const started = await run(`uitest uiRecord record -l > ${RECORD_CONSOLE} 2>&1 & echo "ONIRO_PID=$!"`);
    const pidMatch = /ONIRO_PID=(\d+)/.exec(started.stdout);
    if (!pidMatch) throw new OniroError(`Could not start uitest uiRecord:\n${started.stdout}${started.stderr}`);
    pid = Number(pidMatch[1]);

    // The recorder prints "Started Recording Successfully" once it listens.
    let consoleText = '';
    for (let i = 0; i < 20; i++) {
      consoleText = (await run(`cat ${RECORD_CONSOLE}`)).stdout;
      if (/Started Recording/i.test(consoleText)) break;
      const alive = await run(`kill -0 ${pid} 2>/dev/null && echo alive`);
      if (!alive.stdout.includes('alive')) {
        pid = undefined;
        throw new OniroError(`uitest uiRecord stopped right away:\n${consoleText.trim()}`);
      }
      await sleep(250);
    }
    if (!/Started Recording/i.test(consoleText)) throw new OniroError(`uitest uiRecord did not start:\n${consoleText.trim()}`);
    logger.info('recording; act on the device' + (opts.durationMs ? ` (stops after ${opts.durationMs} ms)` : ' (Ctrl+C stops)'));

    const deadline = opts.durationMs !== undefined ? Date.now() + opts.durationMs : Infinity;
    const pollMs = opts.pollMs ?? 1000;
    let seen = 0;
    while (!opts.abortSignal?.aborted && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), opts.abortSignal);
      const probe = await run(`kill -0 ${pid} 2>/dev/null && echo alive; wc -l < ${UI_RECORD_CSV} 2>/dev/null`).catch(() => null);
      if (!probe) continue;
      const count = Number(/(\d+)\s*$/.exec(probe.stdout.trim())?.[1] ?? seen);
      if (count !== seen) {
        seen = count;
        opts.onEvents?.(count);
      }
      if (!probe.stdout.includes('alive')) {
        logger.warn('uitest uiRecord exited on its own; keeping what it recorded');
        pid = undefined;
        break;
      }
    }
    if (pid !== undefined) {
      await stopRecorder(run, pid);
      pid = undefined;
    }
    killProcessTree(touchLog);
    touchLog = undefined;

    consoleText = (await run(`cat ${RECORD_CONSOLE}`)).stdout;
    const csv = (await run(`cat ${UI_RECORD_CSV}`, 30_000)).stdout;
    const events = parseUiRecordLines(csv);
    const layouts = new Map<string, LayoutNode>();
    const files = [...new Set(events.map((e) => e.FILEPAHT).filter((f): f is string => !!f))];
    const tmp = opts.rawDir ? path.resolve(opts.rawDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-record-'));
    if (opts.rawDir) fs.mkdirSync(tmp, { recursive: true });
    const warnings: string[] = [];
    // uitest writes an event only once the next touch starts, so place events and layouts on the device clock.
    let times: RecordingTimes | undefined;
    if (initialTime !== undefined) {
      const stat = files.length > 0 ? await run(`stat -c '%y|%n' ${files.join(' ')}`).catch(() => null) : null;
      const layoutTimes = new Map<string, number>();
      for (const line of stat?.stdout.split(/\r?\n/) ?? []) {
        const [when, file] = line.trim().split('|');
        const t = when ? parseDeviceTime(when) : undefined;
        if (file && t !== undefined) layoutTimes.set(file, t);
      }
      const touchDowns = parseTouchDowns(touchText, startedAt, initialTime);
      if (touchDowns.length > 0 && layoutTimes.size === files.length) {
        times = { initial: initialTime, touchDowns, layouts: layoutTimes };
      }
    }
    if (!times && events.length > 0) warnings.push('could not read touch and layout times from the device; layouts are matched to events in order');
    const final = (await dumpLayout({ config, deviceSerial, logger }).catch(() => null))?.tree;
    if (opts.rawDir) {
      const save = (name: string, data: unknown): void =>
        fs.writeFileSync(path.join(tmp, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
      save('record.csv', csv);
      save('console.txt', consoleText);
      save('recording.json', {
        display,
        imeBundles,
        api,
        startedAt,
        touchLog: touchText,
        times: times ? { ...times, layouts: Object.fromEntries(times.layouts) } : null,
        initial,
        final: final ?? null,
      });
    }
    try {
      for (const remote of files) {
        const local = path.join(tmp, path.posix.basename(remote));
        try {
          await recvFile({ config, remote, local, deviceSerial, timeoutMs: 60_000, logger });
          const raw = JSON.parse(fs.readFileSync(local, 'utf8')) as RawLayoutNode;
          const pruned = pruneLayout(raw, display, findCoveredNodes(raw));
          layouts.set(remote, Array.isArray(pruned) ? { children: pruned } : (pruned ?? { children: [] }));
        } catch (err) {
          warnings.push(`could not read the layout ${remote}: ${(err as Error).message}`);
        }
      }
    } finally {
      if (!opts.rawDir) fs.rmSync(tmp, { recursive: true, force: true });
      const names = files.filter((f) => /^\/data\/local\/tmp\/layout_[\w.-]+\.json$/.test(f));
      await run(`rm -f ${[RECORD_CONSOLE, UI_RECORD_CSV, ...names].join(' ')}`).catch(() => undefined);
    }

    const fg = parseRecorderForeground(consoleText);
    const foreground = fg && !/^SCB/.test(fg.bundle) ? fg : undefined;
    const bundle = opts.bundle ?? foreground?.bundle;
    const result = flowFromRecording({
      events,
      layouts,
      initial,
      ...(final ? { final } : {}),
      ...(times ? { times } : {}),
      display,
      imeBundles,
      bundle,
      ability: bundle && bundle === foreground?.bundle ? foreground.ability : undefined,
      api,
    });
    return { ...result, warnings: [...warnings, ...result.warnings], events: events.length };
  } finally {
    if (pid !== undefined) await stopRecorder(run, pid).catch(() => undefined);
    if (touchLog) killProcessTree(touchLog);
    await restoreScreen?.();
  }
}

/** SIGINT the recorder (as Ctrl+C would, so it closes its file), then SIGKILL if it lingers. */
async function stopRecorder(run: (command: string) => Promise<{ stdout: string }>, pid: number): Promise<void> {
  await run(`kill -INT ${pid}`);
  for (let i = 0; i < 20; i++) {
    const alive = await run(`kill -0 ${pid} 2>/dev/null && echo alive`);
    if (!alive.stdout.includes('alive')) return;
    await sleep(250);
  }
  await run(`kill -9 ${pid}`);
}
