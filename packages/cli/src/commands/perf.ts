import { Command, InvalidArgumentError } from 'commander';
import * as path from 'node:path';
import {
  DEFAULT_PERF_FLOW_TAIL_MS,
  DEFAULT_PERF_FOR_MS,
  DEFAULT_TRACE_BUFFER_KB,
  DEFAULT_TRACE_CATEGORIES,
  evaluatePerfGate,
  parseTraceFile,
  perfSliceFilter,
  perfTrace,
  readFlowFile,
  summarizeTrace,
  type PerfGateResult,
  type PerfThresholds,
  type PerfTraceReport,
  type TraceSummary,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { projectBundle } from '../lib/crashReport.js';

interface TraceOpts {
  flow?: string;
  launch?: boolean;
  for?: number;
  bundle?: string;
  ability?: string;
  out?: string;
  categories?: string[];
  bufferKb: number;
  hiperf?: boolean;
  maxJankRate?: number;
  maxStartupMs?: number;
  stepTimeout?: number;
  fallback?: boolean;
  wake: boolean;
  device?: string;
  json?: boolean;
}

interface SummaryOpts {
  bundle?: string;
  launched?: boolean;
  pid?: number;
  refreshRate?: number;
  maxJankRate?: number;
  maxStartupMs?: number;
  json?: boolean;
}

function positiveMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('Expected a positive number of milliseconds.');
  return Math.floor(n);
}

function rate(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new InvalidArgumentError('Expected a rate between 0 and 1, e.g. 0.05.');
  return n;
}

function positiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('Expected a positive integer.');
  return n;
}

function positiveNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('Expected a positive number.');
  return n;
}

function list(raw: string): string[] {
  return raw.split(/[,\s]+/).filter(Boolean);
}

/** 2 when the capture did not complete, 1 when a threshold (or the flow) failed, else 0. */
export function perfExitCode(report: Pick<PerfTraceReport, 'ok'>, gate: PerfGateResult): number {
  if (!report.ok) return 2;
  return gate.passed ? 0 : 1;
}

const ms = (n: number): string => `${Math.round(n * 10) / 10} ms`;

/** The text report. */
export function formatPerfReport(
  r: Pick<PerfTraceReport, 'bundle' | 'durationMs' | 'refreshRateHz' | 'frames' | 'startup' | 'mainThread' | 'scenes' | 'notes' | 'pid'> &
    Partial<Pick<PerfTraceReport, 'flow' | 'trace' | 'hiperf'>>,
  gate?: PerfGateResult,
): string {
  const lines = [
    `${r.bundle}${r.pid !== null ? ` (pid ${r.pid})` : ''}: ${(r.durationMs / 1000).toFixed(1)} s captured` +
      (r.refreshRateHz ? `, display ${r.refreshRateHz} Hz (${ms(1000 / r.refreshRateHz)} per frame)` : ''),
  ];
  const f = r.frames;
  if (f) {
    lines.push(
      `  frames: ${f.total}, janky ${f.janky} (${(f.jankRate * 100).toFixed(1)}%), p50 ${ms(f.p50Ms)}, p95 ${ms(f.p95Ms)}, ` +
        `max ${ms(f.maxMs)}, ${f.missedVsyncs} vsync(s) missed`,
    );
    if (f.longest.length) lines.push(`  longest: ${f.longest.map((l) => `${ms(l.ms)} at +${(l.atMs / 1000).toFixed(2)} s`).join(', ')}`);
  }
  if (r.startup) {
    const s = r.startup;
    lines.push(
      `  startup: cold ${ms(s.coldMs)} (${s.from} → ${s.to})` +
        (s.processMs !== null ? `, process up after ${ms(s.processMs)}` : '') +
        (s.firstFrameMs !== null ? `, first frame ${ms(s.firstFrameMs)}` : ''),
    );
  }
  if (r.mainThread) {
    lines.push(`  main thread: ${ms(r.mainThread.busyMs)} in traced work${r.mainThread.cpuMs !== null ? `, ${ms(r.mainThread.cpuMs)} on CPU` : ''}`);
  }
  for (const s of r.scenes) {
    const parts = [
      s.maxFrameMs !== undefined ? `max frame ${s.maxFrameMs} ms` : '',
      s.maxHitchMs !== undefined ? `max hitch ${s.maxHitchMs} ms` : '',
      s.hitchMsPerS !== undefined ? `hitch ${Math.round(s.hitchMsPerS * 10) / 10} ms/s` : '',
      s.responseMs !== undefined ? `response ${s.responseMs} ms` : '',
    ].filter(Boolean);
    lines.push(`  RenderService ${s.scene}${s.page ? ` ${s.page}` : ''}: ${parts.join(', ')}`);
  }
  if (r.flow) {
    lines.push(
      r.flow.outcome === 'passed'
        ? `  flow: passed (${r.flow.steps.length} step(s))`
        : `  flow: ${r.flow.outcome} at step ${r.flow.failedStep ?? '?'} (${r.flow.reason ?? r.flow.error ?? ''}): ${r.flow.message ?? ''}`,
    );
  }
  if (r.hiperf) {
    if ('error' in r.hiperf) lines.push(`  hiperf: ${r.hiperf.error}`);
    else {
      lines.push(`  hiperf: ${r.hiperf.samples} sample(s)${r.hiperf.event ? ` of ${r.hiperf.event}` : ''}${r.hiperf.data ? `, data ${r.hiperf.data}` : ''}`);
      for (const t of r.hiperf.top.slice(0, 10)) lines.push(`    ${t.percent.toFixed(2).padStart(6)}%  ${t.func}  (${t.dso})`);
    }
  }
  if (r.trace) lines.push(`  trace: ${r.trace}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  if (gate && !gate.passed) for (const fail of gate.failures) lines.push(`GATE FAILED: ${fail}`);
  return lines.join('\n');
}

export function registerPerfCommand(program: Command): void {
  const perf = program.command('perf').description('Measure app performance on the device: frames, jank and startup from a hitrace capture.');

  perf
    .command('trace')
    .description(
      'Capture a hitrace trace while the app cold-launches (--launch), a flow is replayed (--flow), or for a fixed ' +
        "time (--for); pull it and summarise it for the bundle: its UI frames (janky when one takes longer than the " +
        "display's refresh interval, from its vsync to done), p50/p95/max frame time, cold-start time (launch request " +
        'to the first frame composited), main-thread load and RenderService jank reports. Exits 0 when the capture ' +
        'completed, 1 when --max-jank-rate or --max-startup-ms is exceeded (or the flow diverged), 2 when it could not ' +
        'capture.',
    )
    .option('--flow <file>', 'Replay this flow file (see `replay`) while tracing; its bundle is the default --bundle.')
    .option('--launch', 'Force-stop the app, start tracing, then cold-launch it and report its startup time.')
    .option(
      '--for <ms>',
      `Without --flow: how long to capture (after the launch with --launch), default ${DEFAULT_PERF_FOR_MS}. With --flow: how long to keep capturing after it, default ${DEFAULT_PERF_FLOW_TAIL_MS}.`,
      positiveMs,
    )
    .option('--bundle <bundle>', 'The app to measure (default: the flow\'s bundle, else the project in the current directory).')
    .option('--ability <name>', 'Ability --launch starts (default: the main ability).')
    .option('--out <file>', 'Where to save the trace (default: a file in the system temp dir).')
    .option('--categories <list>', `hitrace categories, comma-separated (default ${DEFAULT_TRACE_CATEGORIES.join(',')}; add sched for main-thread CPU time).`, list)
    .option('--buffer-kb <kb>', 'hitrace buffer size in KB.', positiveInt, DEFAULT_TRACE_BUFFER_KB)
    .option('--hiperf', "Also sample the app's process with hiperf during the capture and list its top functions.")
    .option('--max-jank-rate <r>', 'Exit 1 when the share of janky frames is above this (0..1).', rate)
    .option('--max-startup-ms <ms>', 'Exit 1 when the cold start takes longer than this (needs --launch).', positiveMs)
    .option('--step-timeout <ms>', "With --flow: how long to wait for a step's selector and expect.", positiveMs)
    .option('--fallback', "With --flow: act on a step's fallback point when its selector is not found.")
    .option('--no-wake', 'Leave the screen as it is (by default, with --launch or --flow, it is woken, a credential-less lock screen swiped away, and kept on).')
    .option('--device <serial>', 'Target device serial.')
    .option('--json', 'Print the report as JSON: ok, bundle, durationMs, trace, refreshRateHz, frames, startup, flow, pid, mainThread, scenes, hiperf, notes, gate, error.')
    .action(async (opts: TraceOpts) => {
      const { config, logger } = getRuntime();
      const thresholds: PerfThresholds = { maxJankRate: opts.maxJankRate, maxStartupMs: opts.maxStartupMs };
      let report: PerfTraceReport;
      try {
        const flow = opts.flow ? readFlowFile(path.resolve(opts.flow)) : undefined;
        report = await perfTrace({
          config,
          logger,
          deviceSerial: opts.device,
          bundle: opts.bundle ?? flow?.bundle ?? projectBundle(process.cwd()),
          ability: opts.ability,
          launch: opts.launch,
          flow,
          replay: {
            stepTimeoutMs: opts.stepTimeout,
            fallback: opts.fallback,
            onStep: opts.json ? undefined : (s) => logger.info(`flow step ${s.index} ${s.action} ${s.ok ? 'ok' : 'FAILED'}`),
          },
          forMs: opts.for,
          out: opts.out ? path.resolve(opts.out) : undefined,
          categories: opts.categories,
          bufferKb: opts.bufferKb,
          hiperf: opts.hiperf,
          wake: opts.wake,
        });
      } catch (err) {
        report = emptyReport(opts.bundle ?? '', (err as Error).message);
      }
      const gate = evaluatePerfGate(report, thresholds);
      if (opts.json) process.stdout.write(`${JSON.stringify({ ...report, gate }, null, 2)}\n`);
      else if (report.ok) process.stdout.write(`${formatPerfReport(report, gate)}\n`);
      if (report.error) logger.error(report.error);
      process.exitCode = perfExitCode(report, gate);
    });

  perf
    .command('summary <trace>')
    .description(
      'Summarise a hitrace text trace taken earlier (by `perf trace --out`, or `hitrace -o` by hand) for a bundle, ' +
        'the same way `perf trace` does. Exit codes as `perf trace`.',
    )
    .option('--bundle <bundle>', 'The app to summarise (default: the project in the current directory).')
    .option('--launched', 'The trace holds a cold launch: report startup and leave the first frame out of the frame stats.')
    .option('--pid <pid>', "The app's pid, when the trace holds several of its processes.", positiveInt)
    .option('--refresh-rate <hz>', 'Refresh rate to use when the trace has no vsync period.', positiveNumber)
    .option('--max-jank-rate <r>', 'Exit 1 when the share of janky frames is above this (0..1).', rate)
    .option('--max-startup-ms <ms>', 'Exit 1 when the cold start takes longer than this.', positiveMs)
    .option('--json', 'Print the summary as JSON.')
    .action(async (trace: string, opts: SummaryOpts) => {
      const { logger } = getRuntime();
      const bundle = opts.bundle ?? projectBundle(process.cwd());
      const file = path.resolve(trace);
      let report: PerfTraceReport;
      if (!bundle) report = emptyReport('', 'No bundle to summarise: pass --bundle.');
      else {
        try {
          const model = await parseTraceFile(file, { keepSlice: perfSliceFilter });
          const s: TraceSummary = summarizeTrace(model, { bundle, launched: opts.launched, pid: opts.pid, refreshRateHz: opts.refreshRate });
          report = { ...emptyReport(bundle), ...s, ok: true, trace: file };
        } catch (err) {
          report = emptyReport(bundle, `Could not read ${file}: ${(err as Error).message}`);
        }
      }
      const gate = evaluatePerfGate(report, { maxJankRate: opts.maxJankRate, maxStartupMs: opts.maxStartupMs });
      if (opts.json) process.stdout.write(`${JSON.stringify({ ...report, gate }, null, 2)}\n`);
      else if (report.ok) process.stdout.write(`${formatPerfReport(report, gate)}\n`);
      if (report.error) logger.error(report.error);
      process.exitCode = perfExitCode(report, gate);
    });
}

function emptyReport(bundle: string, error?: string): PerfTraceReport {
  return {
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
    categories: [],
    notes: [],
    ...(error ? { error } : {}),
  };
}
