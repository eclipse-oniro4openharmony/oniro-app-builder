import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { selectDevice } from '../hdc/devices.js';
import { shell, shellChecked } from '../hdc/exec.js';
import { recvFile } from '../hdc/files.js';
import { findRunningProcess, forceStop, launchApp } from '../hdc/app.js';
import { holdScreenOn, wakeAndUnlock } from '../hdc/power.js';
import { replayFlow, type ReplayFlowOptions, type ReplayReport } from '../flow/replay.js';
import type { Flow } from '../flow/flowFile.js';
import { parseTraceFile } from './hitrace.js';
import { perfSliceFilter, summarizeTrace, type PerfFrameStats, type PerfScene, type PerfStartup, type TraceSummary } from './summary.js';
import { parseHiperfReport, type HiperfReport } from './hiperf.js';

/**
 * Categories captured by default: ArkUI (frames), graphic (vsync period,
 * RenderService first-frame and jank reports), app and ability (launch),
 * window. `sched` adds the main thread's CPU time, at a large cost in buffer.
 */
export const DEFAULT_TRACE_CATEGORIES = ['ace', 'app', 'graphic', 'ability', 'window'] as const;
/** hitrace buffer, KB (its own default is 18432). */
export const DEFAULT_TRACE_BUFFER_KB = 65_536;
/** How long a `--launch` capture keeps running after the launch, and a plain capture lasts, ms. */
export const DEFAULT_PERF_FOR_MS = 5_000;
/** How long a `--flow` capture keeps running after the flow, ms. */
export const DEFAULT_PERF_FLOW_TAIL_MS = 1_000;

const REMOTE_DIR = '/data/local/tmp';

export interface PerfTraceOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  logger?: Logger;
  /** The app to measure. Defaults to the flow's bundle. */
  bundle?: string;
  /** Ability `launch` starts (default: the bundle's main ability, or the flow's). */
  ability?: string;
  /** Force-stop and cold-launch the bundle once tracing runs; reports startup. */
  launch?: boolean;
  /** Replay this flow while tracing (after the launch, with `launch`). */
  flow?: Flow;
  /** Replay options passed through (step timeout, fallback, screenshots). */
  replay?: Pick<ReplayFlowOptions, 'stepTimeoutMs' | 'fallback' | 'screenshotsDir' | 'from' | 'to' | 'onStep'>;
  /**
   * Without a flow: how long to capture (after the launch with `launch`), ms;
   * default {@link DEFAULT_PERF_FOR_MS}. With a flow: how long to keep capturing
   * after it, default {@link DEFAULT_PERF_FLOW_TAIL_MS}.
   */
  forMs?: number;
  /** Local path for the trace (default: a new file in the system temp dir). */
  out?: string;
  /** hitrace categories (default {@link DEFAULT_TRACE_CATEGORIES}). */
  categories?: string[];
  /** hitrace buffer size, KB (default {@link DEFAULT_TRACE_BUFFER_KB}). */
  bufferKb?: number;
  /** Turn the screen on and swipe away a credential-less lock screen, and keep it on. Default true. */
  wake?: boolean;
  /** Also sample the app's process with hiperf and report its top functions. */
  hiperf?: boolean;
  abortSignal?: AbortSignal;
}

export interface PerfTraceReport {
  /** The capture completed and was summarised. */
  ok: boolean;
  bundle: string;
  durationMs: number;
  /** The trace, pulled to the host. */
  trace: string | null;
  refreshRateHz: number | null;
  frames: PerfFrameStats | null;
  startup: PerfStartup | null;
  flow: ReplayReport | null;
  pid: number | null;
  mainThread: TraceSummary['mainThread'] | null;
  scenes: PerfScene[];
  hiperf?: (HiperfReport & { data: string | null }) | { error: string };
  categories: string[];
  notes: string[];
  /** Why the capture could not complete. */
  error?: string;
}

export interface PerfThresholds {
  /** Fail when frames.jankRate is above this (0..1). */
  maxJankRate?: number;
  /** Fail when startup.coldMs is above this. */
  maxStartupMs?: number;
}

export interface PerfGateResult {
  passed: boolean;
  failures: string[];
}

/** Check a report against thresholds; a metric that was not measured fails a threshold set on it. Pure. */
export function evaluatePerfGate(report: Pick<PerfTraceReport, 'frames' | 'startup' | 'flow'>, t: PerfThresholds): PerfGateResult {
  const failures: string[] = [];
  if (report.flow && report.flow.outcome !== 'passed') {
    failures.push(
      `The flow did not complete (${report.flow.outcome}${report.flow.failedStep !== undefined ? ` at step ${report.flow.failedStep}` : ''}); the trace does not cover it.`,
    );
  }
  if (t.maxJankRate !== undefined) {
    if (!report.frames || report.frames.total === 0) failures.push('No frames were captured to judge the jank rate.');
    else if (report.frames.jankRate > t.maxJankRate) {
      failures.push(`Jank rate ${report.frames.jankRate} (${report.frames.janky}/${report.frames.total} frames) is above ${t.maxJankRate}.`);
    }
  }
  if (t.maxStartupMs !== undefined) {
    if (!report.startup) failures.push('No startup time was measured (use --launch).');
    else if (report.startup.coldMs > t.maxStartupMs) failures.push(`Cold start ${report.startup.coldMs} ms is above ${t.maxStartupMs} ms.`);
  }
  return { passed: failures.length === 0, failures };
}

/** `activeMode: 1080x2400, refreshRate=59` in `hidumper -s RenderService -a screen`. Pure. */
export function parseActiveRefreshRate(hidumper: string): number | null {
  const m = /activeMode:[^\n]*?refreshRate=(\d+(?:\.\d+)?)/.exec(hidumper);
  return m ? Number(m[1]) : null;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError('Capture cancelled.'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new CancelledError('Capture cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const BUNDLE_RE = /^[A-Za-z][\w.]*$/;
const CATEGORY_RE = /^[a-z0-9_]+$/;

/**
 * Capture a hitrace trace on the device while the app cold-launches, a flow is
 * replayed, or for a fixed time; pull it and summarise it for the bundle (see
 * {@link summarizeTrace}). Never throws for a failed capture or a missing
 * device: `ok` is false and `error` says why. Tracing is always stopped.
 */
export async function perfTrace(opts: PerfTraceOptions): Promise<PerfTraceReport> {
  const logger = opts.logger ?? noopLogger;
  const { config } = opts;
  const bundle = opts.bundle ?? opts.flow?.bundle ?? '';
  const categories = opts.categories?.length ? opts.categories : [...DEFAULT_TRACE_CATEGORIES];
  const report: PerfTraceReport = {
    ok: false,
    bundle,
    durationMs: 0,
    trace: null,
    refreshRateHz: null,
    frames: null,
    startup: null,
    flow: null,
    pid: null,
    mainThread: null,
    scenes: [],
    categories,
    notes: [],
  };
  if (!bundle) return { ...report, error: 'No bundle to measure: pass one, or a flow that names its bundle.' };
  if (!BUNDLE_RE.test(bundle)) return { ...report, error: `Not a bundle name: ${bundle}` };
  const badCategory = categories.find((c) => !CATEGORY_RE.test(c));
  if (badCategory) return { ...report, error: `Not a hitrace category: ${badCategory}` };
  const bufferKb = Math.floor(opts.bufferKb ?? DEFAULT_TRACE_BUFFER_KB);

  let deviceSerial: string;
  try {
    deviceSerial = await selectDevice(config, opts.deviceSerial, { logger });
  } catch (err) {
    return { ...report, error: (err as Error).message };
  }
  const device = { config, deviceSerial, logger };
  const run = (command: string, timeoutMs = 30_000) => shellChecked({ ...device, command, timeoutMs });

  const stamp = `${Date.now()}`;
  const remoteTrace = `${REMOTE_DIR}/oniro_perf_${stamp}.ftrace`;
  const remotePerf = `${REMOTE_DIR}/oniro_perf_${stamp}.data`;
  const local = path.resolve(opts.out ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-perf-')), `${bundle}.ftrace`));

  let tracing = false;
  let restoreScreen: (() => Promise<void>) | undefined;
  let hiperfPid: number | undefined;
  let pidHint: number | undefined;
  try {
    if (opts.wake !== false && (opts.launch || opts.flow)) {
      const screen = await wakeAndUnlock(device);
      if (screen.locked) return { ...report, error: 'The lock screen asks for a credential; unlock the device first.' };
      restoreScreen = await holdScreenOn({ ...device, ms: 1_800_000 });
    }
    if (opts.launch) {
      // Stop it before tracing so the capture holds a cold start, not the kill.
      await forceStop({ ...device, bundle }).catch(() => undefined);
    }

    const begin = `hitrace --trace_begin -b ${bufferKb} ${categories.join(' ')}`;
    let started = await run(begin);
    if (started.code !== 0 && /1103|already/i.test(started.stdout)) {
      // A capture left running (an interrupted run): stop it and take over.
      report.notes.push('A hitrace capture was already running on the device; it was stopped.');
      await run('hitrace --trace_finish_nodump');
      started = await run(begin);
    }
    if (started.code !== 0) throw new OniroError(`hitrace could not start: ${lastLines(started.stdout)}`);
    tracing = true;
    logger.info(`tracing ${categories.join(', ')} (${bufferKb} KB buffer)`);

    if (opts.launch) {
      await launchApp({ ...device, bundleName: bundle, abilityName: opts.ability ?? opts.flow?.ability });
      logger.info(`launched ${bundle}`);
    }
    if (opts.hiperf) hiperfPid = await startHiperf(run, device, bundle, remotePerf, report, opts.launch);

    if (opts.flow) {
      const flow = await replayFlow({
        ...device,
        ...opts.replay,
        flow: opts.flow,
        // The screen was woken above; the app was launched above when asked.
        wake: false,
        launch: false,
        abortSignal: opts.abortSignal,
      });
      report.flow = flow;
      if (flow.outcome === 'error') throw new OniroError(`The flow could not run: ${flow.error}`);
      await sleep(opts.forMs ?? DEFAULT_PERF_FLOW_TAIL_MS, opts.abortSignal);
    } else {
      await sleep(opts.forMs ?? DEFAULT_PERF_FOR_MS, opts.abortSignal);
    }

    const running = await findRunningProcess({ ...device, bundle }).catch(() => null);
    if (running && /^\d+$/.test(running.pid)) pidHint = Number(running.pid);

    if (hiperfPid !== undefined) {
      await stopProcess(run, hiperfPid);
      hiperfPid = undefined;
      report.hiperf = await collectHiperf(run, device, remotePerf, `${local.replace(/\.[^./\\]+$/, '')}.perf.data`);
    }

    const finished = await run(`hitrace --trace_finish -o ${remoteTrace}`, 300_000);
    tracing = false;
    if (finished.code !== 0) throw new OniroError(`hitrace could not write the trace: ${lastLines(finished.stdout)}`);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    await recvFile({ ...device, remote: remoteTrace, local, timeoutMs: 600_000 });
    report.trace = local;
  } catch (err) {
    report.error = (err as Error).message;
  } finally {
    if (hiperfPid !== undefined) await stopProcess(run, hiperfPid).catch(() => undefined);
    if (tracing) await run('hitrace --trace_finish_nodump').catch(() => undefined);
    await shell({ ...device, command: `rm -f ${remoteTrace} ${remotePerf}`, timeoutMs: 15_000 }).catch(() => undefined);
    await restoreScreen?.();
  }
  if (report.error) return report;

  const rate = parseActiveRefreshRate(
    (await shell({ ...device, command: 'hidumper -s RenderService -a screen', timeoutMs: 15_000 }).catch(() => null))?.stdout ?? '',
  );
  try {
    const model = await parseTraceFile(local, { keepSlice: perfSliceFilter });
    const summary = summarizeTrace(model, {
      bundle,
      pid: pidHint,
      refreshRateHz: rate ?? undefined,
      launched: !!opts.launch,
    });
    Object.assign(report, {
      ok: true,
      pid: summary.pid,
      durationMs: summary.durationMs,
      refreshRateHz: summary.refreshRateHz,
      frames: summary.frames,
      startup: summary.startup,
      mainThread: summary.mainThread,
      scenes: summary.scenes,
    });
    report.notes.push(...summary.notes);
  } catch (err) {
    report.error = `Could not read the trace ${local}: ${(err as Error).message}`;
  }
  return report;
}

function lastLines(text: string, n = 3): string {
  return text.trim().split(/\r?\n/).slice(-n).join(' | ');
}

type Run = (command: string, timeoutMs?: number) => Promise<{ code: number; stdout: string }>;

/** Start `hiperf record` on the app's process in the background; returns hiperf's pid, or undefined with a note. */
async function startHiperf(
  run: Run,
  device: { config: ConfigProvider; deviceSerial: string; logger: Logger },
  bundle: string,
  remotePerf: string,
  report: PerfTraceReport,
  launched?: boolean,
): Promise<number | undefined> {
  // Right after a launch the process may take a moment to show up.
  let proc = await findRunningProcess({ ...device, bundle }).catch(() => null);
  for (let i = 0; !proc && launched && i < 10; i++) {
    await sleep(300);
    proc = await findRunningProcess({ ...device, bundle }).catch(() => null);
  }
  if (!proc || !/^\d+$/.test(proc.pid)) {
    report.hiperf = { error: `${bundle} is not running, so hiperf has no process to sample (add --launch).` };
    return undefined;
  }
  const started = await run(`hiperf record -p ${proc.pid} -f 1000 -o ${remotePerf} > /dev/null 2>&1 & echo "ONIRO_PID=$!"`);
  const pid = /ONIRO_PID=(\d+)/.exec(started.stdout);
  if (!pid) {
    report.hiperf = { error: `hiperf could not start: ${lastLines(started.stdout)}` };
    return undefined;
  }
  device.logger.info(`hiperf sampling ${bundle} (pid ${proc.pid})`);
  return Number(pid[1]);
}

/** SIGINT (hiperf then writes its data file), then SIGKILL if it lingers. */
async function stopProcess(run: Run, pid: number): Promise<void> {
  await run(`kill -INT ${pid}`);
  for (let i = 0; i < 40; i++) {
    const alive = await run(`kill -0 ${pid} 2>/dev/null && echo alive`);
    if (!alive.stdout.includes('alive')) return;
    await sleep(250);
  }
  await run(`kill -9 ${pid}`);
}

async function collectHiperf(
  run: Run,
  device: { config: ConfigProvider; deviceSerial: string; logger: Logger },
  remotePerf: string,
  localPerf: string,
): Promise<(HiperfReport & { data: string | null }) | { error: string }> {
  const res = await run(`hiperf report -i ${remotePerf} --sort dso,func --limit-percent 0.5`, 120_000);
  const parsed = parseHiperfReport(res.stdout);
  if (res.code !== 0 || (parsed.samples === 0 && parsed.top.length === 0)) {
    return { error: `hiperf report failed or had no samples: ${lastLines(res.stdout)}` };
  }
  let data: string | null = localPerf;
  try {
    await recvFile({ ...device, remote: remotePerf, local: localPerf, timeoutMs: 120_000 });
  } catch {
    data = null;
  }
  return { ...parsed, data };
}
