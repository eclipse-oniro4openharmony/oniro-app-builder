import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { BuildFailedError, buildHap } from '../build/buildHap.js';
import { buildOutputTail, type BuildDiagnostic } from '../build/diagnostics.js';
import { discoverHaps, pickHap } from '../build/discoverHaps.js';
import { hdcExec, shell, type OutputSink } from '../hdc/exec.js';
import { ensureInstallOk, existingHapOrUnsigned } from '../hdc/app.js';
import { parseHilogLine, streamHilog } from '../hdc/hilog.js';
import { killProcessTree } from '../hdc/spawnCompat.js';
import { holdScreenOn, wakeAndUnlock } from '../hdc/power.js';
import { getBundleName } from '../hdc/project.js';
import { applyChanges } from '../install/apply.js';
import { listModules } from '../project/listModules.js';
import { readJson5File } from '../project/jsonHelpers.js';
import { toLongPath } from '../sdk/paths.js';
import { SdkNotInstalledError } from '../ports/errors.js';
import { parseTestOutput, type TestCaseResult, type TestSummary } from './parseTestOutput.js';

export interface RunTestsOptions {
  config: ConfigProvider;
  projectDir: string;
  /** The module whose `src/ohosTest` suite runs. Default `entry`. */
  module?: string;
  /** hvigor product. Default `default`. */
  product?: string;
  /** Run only these: `Suite`, `Suite#case`, or several joined by commas (the runner's `-s class`). */
  testClass?: string;
  /** Per-case timeout passed to the runner (`-s timeout`), ms. Default 15000. */
  caseTimeoutMs?: number;
  /** Wall-clock limit for the whole `aa test` run, ms; `aa test` can hang when the runner dies. Default 600000. */
  runTimeoutMs?: number;
  /** Build the main and test HAPs first. Default true. */
  build?: boolean;
  /**
   * Turn the screen on, swipe away a lock screen without a credential, and keep
   * the screen on during the run, so UI tests reach the app. Default true.
   */
  wakeScreen?: boolean;
  /** hvigor build mode (e.g. debug). */
  mode?: string;
  /** Run `ohpm install --all` first when `oh_modules/` is missing. Default true. */
  autoInstallDeps?: boolean;
  deviceSerial?: string;
  abortSignal?: AbortSignal;
  /** Build and runner output as it arrives. */
  onOutput?: OutputSink;
  logger?: Logger;
}

/** How the run ended: every case passed, some case failed or threw, or the run itself did not complete. */
export type TestOutcome = 'passed' | 'failed' | 'runner-error';

export interface TestRunReport {
  ok: boolean;
  outcome: TestOutcome;
  module: string;
  bundle?: string;
  /** The test module's name, from `src/ohosTest/module.json5` (`entry_test` in the templates). Left installed. */
  testModule?: string;
  tests: TestCaseResult[];
  summary: TestSummary;
  /** `TestFinished-ResultCode`: 0 when the run completed, whatever the cases did. */
  resultCode?: number;
  resultMessage?: string;
  /** `OHOS_REPORT_CODE`: 0 when every case passed. */
  reportCode?: number;
  haps: { main?: string; test?: string };
  /** Why the run did not complete (outcome `runner-error`). */
  error?: string;
  /** For a build that failed: its diagnostics and task (see `build --json`). */
  failedTask?: string;
  diagnostics?: BuildDiagnostic[];
  /** hilog lines of the app's processes during the run (last 300): assertion logs, JS crash stacks. */
  log: string[];
  /** Things that may explain a failure without being one, e.g. a lock screen that needs a credential. */
  warnings: string[];
  durationMs: number;
  /** The last 200 lines of `aa test` output (or of the build output, when the build failed). */
  rawTail: string;
}

const EMPTY_SUMMARY: TestSummary = { run: 0, pass: 0, fail: 0, error: 0, ignore: 0 };
const LOG_LINES_KEPT = 300;

/** Where hvigor writes a module's test HAP for a product. */
export function testHapPath(moduleDir: string, module: string, product = 'default', signed = true): string {
  return path.join(moduleDir, 'build', product, 'outputs', 'ohosTest', `${module}-ohosTest-${signed ? 'signed' : 'unsigned'}.hap`);
}

/**
 * The `aa test` command line. Pure. `testClass` is a `Suite`, `Suite#case`, or
 * a comma-separated list of them; it is quoted for the device shell.
 */
export function aaTestCommand(opts: {
  bundle: string;
  testModule: string;
  caseTimeoutMs?: number;
  testClass?: string;
}): string {
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = ['aa', 'test', '-b', quote(opts.bundle), '-m', quote(opts.testModule), '-s', 'unittest', 'OpenHarmonyTestRunner'];
  if (opts.testClass) parts.push('-s', 'class', quote(opts.testClass));
  parts.push('-s', 'timeout', String(Math.floor(opts.caseTimeoutMs ?? 15_000)));
  return parts.join(' ');
}

/** The test module name declared in `<moduleDir>/src/ohosTest/module.json5`. */
export function readTestModuleName(moduleDir: string): string {
  const file = path.join(moduleDir, 'src', 'ohosTest', 'module.json5');
  if (!fs.existsSync(file)) {
    throw new OniroError(`No test module: ${file} does not exist. Add an ohosTest source set to the module.`);
  }
  const name = readJson5File<{ module?: { name?: string } }>(file).module?.name;
  if (!name) throw new OniroError(`${file} declares no module.name.`);
  return name;
}

/** The outcome of a parsed run. Pure. */
export function decideOutcome(run: {
  resultCode?: number;
  summary: TestSummary;
  completed: boolean;
}): { outcome: TestOutcome; error?: string } {
  if (!run.completed) return { outcome: 'runner-error', error: 'The test run did not finish (no TestFinished line).' };
  if (run.resultCode !== 0) return { outcome: 'runner-error' };
  if (run.summary.run === 0) return { outcome: 'runner-error', error: 'No test case ran.' };
  return { outcome: run.summary.fail > 0 || run.summary.error > 0 ? 'failed' : 'passed' };
}

/**
 * Build a module's main and `ohosTest` HAPs, install both, run the suite with
 * `aa test` (Hypium's OpenHarmonyTestRunner) and parse the result. Never throws
 * for a failed test, a failed build or a run that did not complete: those come
 * back as `outcome` `failed` or `runner-error`. Throws only when it cannot start
 * (no such module, cancelled).
 */
export async function runTests(opts: RunTestsOptions): Promise<TestRunReport> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'test');
  const start = Date.now();
  const projectDir = toLongPath(opts.projectDir);
  const module = opts.module ?? 'entry';
  const product = opts.product ?? 'default';
  const declared = listModules({ projectDir }).find((m) => m.name === module);
  if (!declared) throw new OniroError(`Module ${module} is not declared in ${path.join(projectDir, 'build-profile.json5')}.`);
  const moduleDir = path.resolve(projectDir, declared.srcPath);
  const testModule = readTestModuleName(moduleDir);
  const bundle = getBundleName(projectDir);

  const warnings: string[] = [];
  const base = { module, bundle, testModule, tests: [], summary: { ...EMPTY_SUMMARY }, haps: {}, log: [] as string[], warnings };
  const fail = (error: string, extra: Partial<TestRunReport> = {}): TestRunReport => ({
    ok: false,
    outcome: 'runner-error',
    ...base,
    error,
    durationMs: Date.now() - start,
    rawTail: '',
    ...extra,
  });

  if (opts.build !== false) {
    for (const target of [module, `${module}@ohosTest`]) {
      logger.info(`building ${target}`);
      try {
        await buildHap({
          config: opts.config,
          projectDir,
          product,
          module: target,
          mode: opts.mode,
          autoInstallDeps: opts.autoInstallDeps,
          abortSignal: opts.abortSignal,
          onOutput: opts.onOutput,
          logger: opts.logger,
        });
      } catch (err) {
        if (err instanceof BuildFailedError) {
          return fail(`Building ${target} failed: ${err.message}`, {
            diagnostics: err.diagnostics,
            ...(err.failedTask ? { failedTask: err.failedTask } : {}),
            rawTail: err.rawTail,
          });
        }
        if (err instanceof SdkNotInstalledError) return fail(err.message);
        throw err;
      }
    }
  }

  const picked = pickHap(await discoverHaps({ projectDir }), module);
  if (!picked) return fail(`No HAP built for module ${module}. Build it first, or drop --no-build.`);
  const testHap = existingHapOrUnsigned(testHapPath(moduleDir, module, product));
  if (!testHap) {
    return fail(`No test HAP at ${testHapPath(moduleDir, module, product)}. Build it first, or drop --no-build.`);
  }
  for (const hap of [picked.path, testHap.path]) {
    if (!/-signed\.hap$/.test(hap)) logger.warn(`No signed HAP found; installing the unsigned ${path.basename(hap)}.`);
  }
  const haps = { main: picked.path, test: testHap.path };

  try {
    // The main HAP the way `app apply` installs it (replace, or reinstall on a
    // signature mismatch, then verify); the test HAP is one more module of the
    // same bundle, installed after it so a reinstall cannot drop it.
    await applyChanges({ config: opts.config, bundle, hapPath: picked.path, deviceSerial: opts.deviceSerial, logger: opts.logger });
    const res = await hdcExec({
      config: opts.config,
      args: ['install', '-r', testHap.path],
      deviceSerial: opts.deviceSerial,
      timeoutMs: 300_000,
      abortSignal: opts.abortSignal,
    });
    ensureInstallOk(res, `hdc install -r ${testHap.path}`, { path: testHap.path, fallback: testHap.fallback });
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    return fail(`Installing the HAPs failed: ${err instanceof Error ? err.message : String(err)}`, { haps });
  }

  let restoreScreen = async (): Promise<void> => undefined;
  if (opts.wakeScreen !== false) {
    try {
      const screen = await wakeAndUnlock({ config: opts.config, deviceSerial: opts.deviceSerial, logger: opts.logger });
      if (screen.locked) {
        warnings.push(
          'The lock screen asks for a credential, so UI tests cannot reach the app. Unlock the device, or remove ' +
            'the lock screen password.',
        );
      }
      restoreScreen = await holdScreenOn({
        config: opts.config,
        deviceSerial: opts.deviceSerial,
        ms: Math.min(opts.runTimeoutMs ?? 600_000, 1_800_000),
      });
    } catch (err) {
      warnings.push(`Could not wake the screen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const log = collectBundleLog(opts.config, bundle, opts.deviceSerial);
  const command = aaTestCommand({ bundle, testModule, caseTimeoutMs: opts.caseTimeoutMs, testClass: opts.testClass });
  logger.info(command);
  let output = '';
  let runError: string | undefined;
  try {
    const res = await shell({
      config: opts.config,
      command,
      deviceSerial: opts.deviceSerial,
      timeoutMs: opts.runTimeoutMs ?? 600_000,
      abortSignal: opts.abortSignal,
      onOutput: (chunk, stream) => {
        output += chunk;
        opts.onOutput?.(chunk, stream);
      },
    });
    output = `${res.stdout}${res.stderr}`;
    if (res.code !== 0) runError = `hdc exited ${res.code}: ${output.trim().split('\n').slice(-3).join(' ')}`;
  } catch (err) {
    if (err instanceof CancelledError) {
      log.stop();
      await restoreScreen();
      throw err;
    }
    runError = err instanceof Error ? err.message : String(err);
  }
  const logLines = log.stop();
  await restoreScreen();

  const parsed = parseTestOutput(output);
  const decided = decideOutcome({ ...parsed, completed: parsed.resultCode !== undefined });
  const error =
    runError ??
    decided.error ??
    (decided.outcome === 'runner-error' ? `The runner reported ${parsed.resultCode}: ${parsed.resultMessage ?? ''}`.trim() : undefined);
  const report: TestRunReport = {
    ok: decided.outcome === 'passed' && !runError,
    outcome: runError ? 'runner-error' : decided.outcome,
    ...base,
    tests: parsed.tests,
    summary: parsed.summary,
    haps,
    log: logLines,
    durationMs: Date.now() - start,
    rawTail: buildOutputTail(output),
  };
  if (parsed.resultCode !== undefined) report.resultCode = parsed.resultCode;
  if (parsed.resultMessage !== undefined) report.resultMessage = parsed.resultMessage;
  if (parsed.reportCode !== undefined) report.reportCode = parsed.reportCode;
  if (error) report.error = error;
  return report;
}

/**
 * Stream hilog while the run lasts and keep the lines of the bundle's
 * processes. The pid is not known up front (the runner starts the app), so it is
 * polled with `pidof` and the lines are filtered when the run stops.
 */
function collectBundleLog(
  config: ConfigProvider,
  bundle: string,
  deviceSerial?: string,
): { stop: () => string[] } {
  const entries: Array<{ pid: string; line: string }> = [];
  const pids = new Set<string>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending = '';
  try {
    child = streamHilog({ config, deviceSerial });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const e = parseHilogLine(line.replace(/\r$/, ''));
        if (e) entries.push({ pid: e.pid, line: line.replace(/\r$/, '') });
      }
      // Bound memory on a chatty device; the poll below keeps pids current.
      if (entries.length > 200_000) entries.splice(0, entries.length - 100_000);
    });
    child.on('error', () => undefined);
  } catch {
    child = undefined;
  }
  let polling = true;
  const safe = bundle.replace(/'/g, `'\\''`);
  const poll = async (): Promise<void> => {
    while (polling) {
      const res = await shell({ config, command: `pidof '${safe}'`, deviceSerial, timeoutMs: 5_000 }).catch(() => null);
      for (const pid of res?.stdout.trim().split(/\s+/) ?? []) if (/^\d+$/.test(pid)) pids.add(pid);
      // Unref'd: once the run is over, the poll must not keep the process alive.
      await new Promise((r) => setTimeout(r, 1_000).unref());
    }
  };
  void poll();
  return {
    stop: () => {
      polling = false;
      if (child) killProcessTree(child);
      return entries.filter((e) => pids.has(e.pid)).map((e) => e.line).slice(-LOG_LINES_KEPT);
    },
  };
}
