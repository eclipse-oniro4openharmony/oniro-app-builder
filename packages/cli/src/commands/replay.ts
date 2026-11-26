import { Command, InvalidArgumentError } from 'commander';
import * as path from 'node:path';
import { readFlowFile, replayFlow, type ReplayReport, type ReplayStepResult } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { withInterrupt } from '../lib/interrupt.js';

interface ReplayOpts {
  json?: boolean;
  from?: number;
  to?: number;
  stepTimeout: number;
  screenshots?: string;
  screenshotSteps?: number[];
  fallback?: boolean;
  launch?: boolean;
  wake: boolean;
  device?: string;
}

function stepIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('Expected a step index (0-based).');
  return n;
}

/** `3,7,19`: the steps to photograph. `none` (or an empty list): no step, the divergence screenshot only. */
export function stepList(raw: string): number[] {
  const text = raw.trim();
  if (text === '' || text === 'none') return [];
  return text.split(',').map((part) => {
    if (!/^\d+$/.test(part.trim())) {
      throw new InvalidArgumentError('Expected step indexes (0-based) separated by commas, such as 3,7,19, or none.');
    }
    return Number(part.trim());
  });
}

function positiveMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('Expected a positive number of milliseconds.');
  return Math.floor(n);
}

/** 0 when every step ran, 1 when the flow diverged, 2 when it could not run. */
export function replayExitCode(report: Pick<ReplayReport, 'outcome'>): number {
  return report.outcome === 'passed' ? 0 : report.outcome === 'diverged' ? 1 : 2;
}

/** `[2] click type=Button,id=continueBtn  ok  1.2 s` */
export function formatReplayStep(s: ReplayStepResult): string {
  const what = s.selector ? ` ${s.selector}` : '';
  const how = s.usedFallback ? ' (at the recorded point)' : '';
  return `[${s.index}] ${s.action}${what}${how}  ${s.ok ? 'ok' : 'FAILED'}  ${(s.durationMs / 1000).toFixed(1)} s`;
}

/** The divergence part of the text report. */
export function formatDivergence(r: ReplayReport): string {
  const lines = [`Diverged at step ${r.failedStep} (${r.reason}): ${r.message}`];
  if (r.screenshot) lines.push(`  screenshot: ${r.screenshot}`);
  for (const n of r.nearMatches ?? []) lines.push(`  near match: ${n.element} (differs in ${n.differs})`);
  if (r.layout) {
    const where = r.layout.appOnScreen ? `on screen in ${r.bundle}` : 'on screen';
    lines.push(`  ${where} (${r.layout.elementCount} element(s)${r.layout.keyboard ? ', keyboard up' : ''}):`);
    for (const e of r.layout.elements) lines.push(`    ${e}`);
    if (r.layout.elementCount > r.layout.elements.length) lines.push(`    … ${r.layout.elementCount - r.layout.elements.length} more`);
  }
  return lines.join('\n');
}

export function registerReplayCommand(program: Command): void {
  program
    .command('replay <flow>')
    .description(
      'Replay a flow file (written by `record` or by hand) on the device: for each step, wait for its selector, ' +
        'act on it the way `input --selector` does, then wait for its `expect`. Stops at the first step that fails ' +
        'and reports the step, why (not-found, expect-not-found, wrong-screen, ambiguous, covered, action-failed), ' +
        'a screenshot and what was on screen. Exits 0 when every step ran, 1 when the flow diverged, 2 when it ' +
        'could not run (invalid flow file, no device).',
    )
    .option('--from <i>', 'First step to run (0-based).', stepIndex)
    .option('--to <i>', 'Last step to run (0-based, inclusive).', stepIndex)
    .option('--step-timeout <ms>', "How long to wait for a step's selector and its expect (a step's timeoutMs overrides it).", positiveMs, 10_000)
    .option('--screenshots <dir>', 'Save a screenshot after every step (step-<i>.jpeg), and the divergence screenshot, here.')
    .option(
      '--screenshot-steps <i,j,…>',
      'With --screenshots: photograph only after these steps (0-based) instead of after every step; `none` keeps the divergence screenshot only. A frame costs about a second on a phone.',
      stepList,
    )
    .option('--fallback', "When a step's selector is not found, act on its recorded fallback point instead of stopping.")
    .option('--launch', "Force-stop and start the flow's app (its bundle and ability) before the first step.")
    .option('--no-wake', 'Leave the screen as it is (by default it is turned on, a lock screen without a credential is swiped away, and it is kept on during the run).')
    .option('--device <serial>', 'Target device serial.')
    .option(
      '--json',
      'Print the report as JSON: ok, outcome, steps, failedStep, reason, message, selector, screenshot, layout, nearMatches, error, warnings.',
    )
    .action(async (flowPath: string, opts: ReplayOpts) => {
      const { config, logger } = getRuntime();
      let report: ReplayReport;
      try {
        if (opts.screenshotSteps && !opts.screenshots) throw new Error('--screenshot-steps needs --screenshots <dir>, where the frames go.');
        const flow = readFlowFile(path.resolve(flowPath));
        report = await withInterrupt(logger, 'stopping the replay', (abortSignal) => replayFlow({
          config,
          flow,
          abortSignal,
          from: opts.from,
          to: opts.to,
          stepTimeoutMs: opts.stepTimeout,
          screenshotsDir: opts.screenshots,
          screenshotSteps: opts.screenshotSteps,
          fallback: opts.fallback,
          launch: opts.launch,
          wake: opts.wake,
          deviceSerial: opts.device,
          logger,
          onStep: opts.json ? undefined : (s) => process.stdout.write(`${formatReplayStep(s)}\n`),
        }));
      } catch (err) {
        report = { ok: false, outcome: 'error', range: [0, 0], steps: [], error: (err as Error).message, warnings: [] };
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else if (report.outcome === 'passed') {
        process.stdout.write(`Flow passed: ${report.steps.length} step(s).\n`);
      } else if (report.outcome === 'diverged') {
        process.stdout.write(`${formatDivergence(report)}\n`);
      }
      for (const w of report.warnings) logger.warn(w);
      if (report.error) logger.error(report.error);
      process.exitCode = replayExitCode(report);
    });
}
