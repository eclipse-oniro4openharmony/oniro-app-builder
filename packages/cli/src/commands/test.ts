import { Command, InvalidArgumentError } from 'commander';
import * as path from 'node:path';
import { runTests, type TestCaseResult, type TestRunReport } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { formatDiagnostics } from './build.js';

interface TestOpts {
  module: string;
  product: string;
  class?: string;
  timeout: number;
  runTimeout: number;
  build: boolean;
  wake: boolean;
  mode?: string;
  deps: boolean;
  device?: string;
  json?: boolean;
}

function positiveMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('Expected a positive number of milliseconds.');
  return Math.floor(n);
}

/** 0 when every case passed, 1 when a case failed or threw, 2 when the run itself did not complete. */
export function testExitCode(report: Pick<TestRunReport, 'outcome'>): number {
  return report.outcome === 'passed' ? 0 : report.outcome === 'failed' ? 1 : 2;
}

/** The first stack frame in the project's own code (not Hypium's), e.g. `entry/src/ohosTest/ets/test/A.test.ets:26:17`. */
export function projectFrame(stack: string | undefined): string | undefined {
  for (const line of stack?.split('\n') ?? []) {
    if (/oh_modules|@ohos\/hypium/.test(line)) continue;
    const m = /\(([^()]+:\d+:\d+)\)\s*$/.exec(line.trim());
    if (m) return m[1];
  }
  return undefined;
}

/** One line per case: `PASS Suite > case (12 ms)`, and for a failure the message and where it was raised. */
export function formatTestCase(t: TestCaseResult): string {
  const label = { pass: 'PASS', fail: 'FAIL', error: 'ERROR', ignore: 'SKIP', unknown: `CODE ${t.statusCode}` }[t.status];
  const time = t.durationMs !== undefined ? ` (${t.durationMs} ms)` : '';
  let line = `${label} ${t.suite} > ${t.name}${time}`;
  if (t.status !== 'pass' && t.message) line += `\n    ${t.message}`;
  const at = t.status !== 'pass' ? projectFrame(t.stack) : undefined;
  if (at) line += `\n    at ${at}`;
  return line;
}

export function registerTestCommand(program: Command): void {
  program
    .command('test [project-dir]')
    .description(
      "Build a module's main and ohosTest HAPs, install both on the device, run the suite with `aa test` " +
        '(Hypium, OpenHarmonyTestRunner) and report each case. Defaults to the current directory. ' +
        'Exits 0 when every case passed, 1 when a case failed or threw, 2 when the run did not complete ' +
        '(build failed, test module not found, timeout, no device). The test module is left installed.',
    )
    .option('--module <module>', 'Module whose src/ohosTest suite runs.', 'entry')
    .option('--product <product>', 'hvigor product name.', 'default')
    .option('--class <filter>', 'Run only these cases: `Suite`, `Suite#case`, or several joined by commas.')
    .option('--timeout <ms>', 'Per-case timeout passed to the runner.', positiveMs, 15_000)
    .option('--run-timeout <ms>', 'Wall-clock limit for the whole run; aa test can hang when the app dies.', positiveMs, 600_000)
    .option('--no-build', 'Use the HAPs already built instead of building them.')
    .option('--no-wake', 'Leave the screen as it is (by default it is turned on, a lock screen without a credential is swiped away, and it is kept on during the run).')
    .option('--mode <mode>', 'hvigor build mode (e.g. debug).')
    .option('--no-deps', 'Skip the automatic `ohpm install --all` when oh_modules/ is missing.')
    .option('--device <serial>', 'Target device serial.')
    .option(
      '--json',
      'Print the report as JSON: ok, outcome, tests (suite, name, status, statusCode, durationMs, message, stack), summary, resultCode, haps, log, error.',
    )
    .action(async (projectDir: string | undefined, opts: TestOpts) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      const report = await runTests({
        config,
        projectDir: dir,
        module: opts.module,
        product: opts.product,
        testClass: opts.class,
        caseTimeoutMs: opts.timeout,
        runTimeoutMs: opts.runTimeout,
        build: opts.build,
        wakeScreen: opts.wake,
        mode: opts.mode,
        autoInstallDeps: opts.deps,
        deviceSerial: opts.device,
        logger,
      });

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        for (const t of report.tests) process.stdout.write(`${formatTestCase(t)}\n`);
        const s = report.summary;
        if (report.tests.length || report.outcome !== 'runner-error') {
          process.stdout.write(
            `${s.run} run: ${s.pass} passed, ${s.fail} failed, ${s.error} errors, ${s.ignore} ignored.\n`,
          );
        }
      }
      for (const w of report.warnings) logger.warn(w);
      if (report.error) {
        const listed = report.diagnostics ? formatDiagnostics(report.diagnostics) : '';
        logger.error(`${report.error}${listed ? `\n${listed}` : ''}`);
      }
      process.exitCode = testExitCode(report);
    });
}
