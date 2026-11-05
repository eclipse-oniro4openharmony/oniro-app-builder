import { Command } from 'commander';
import * as path from 'node:path';
import {
  OniroError,
  buildWithDiagnostics,
  downloadAndInstallSdk,
  type BuildDiagnostic,
  type BuildReport,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface BuildOpts {
  product: string;
  module?: string;
  mode?: string;
  task: string;
  deps: boolean;
  parallel: boolean;
  installSdk?: boolean;
  json?: boolean;
}

export function registerBuildCommand(program: Command): void {
  program
    .command('build [project-dir]')
    .description(
      'Build an OpenHarmony or HarmonyOS app via hvigorw. Defaults to the current directory. ' +
        'Projects declaring runtimeOS "HarmonyOS" build against the HarmonyOS SDK (ONIRO_HARMONYOS_SDK_PATH or an installed DevEco Studio). ' +
        'An OpenHarmony project fails early, naming the release to install, when the SDK for its compileSdkVersion is missing. ' +
        'With --json, one result object is printed whether the build passes or fails; a failed build exits 1.',
    )
    .option('--product <product>', 'hvigor product name', 'default')
    .option('--module <module>', 'restrict the build to a specific module')
    .option('--mode <mode>', 'hvigor build mode (e.g. release, debug)')
    .option('--task <task>', 'hvigor task to run', 'assembleHap')
    .option('--no-deps', 'skip the automatic `ohpm install --all` when oh_modules/ is missing')
    .option('--no-parallel', 'build modules serially (default: parallel)')
    .option('--install-sdk', 'install the OpenHarmony SDK the project compiles against when it is missing, then build')
    .option(
      '--json',
      'print the result as JSON: ok, diagnostics (file, line, column, code, rule, message), summary, failedTask, discoveredHaps, warnings',
    )
    .action(async (projectDir: string | undefined, opts: BuildOpts) => {
      const { config, logger, progress } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      logger.info(`Building project at ${dir}...`);
      const build = () =>
        buildWithDiagnostics({
          config,
          projectDir: dir,
          product: opts.product,
          module: opts.module,
          mode: opts.mode,
          task: opts.task,
          autoInstallDeps: opts.deps,
          parallel: opts.parallel,
          logger,
          // The logger already echoes spawn output; this hook is for streaming to other UIs.
          onOutput: () => {},
        });
      let report: BuildReport;
      try {
        report = await build();
        if (!report.ok && report.missingSdk?.version && opts.installSdk) {
          const { version, api } = report.missingSdk;
          logger.info(`Installing OpenHarmony SDK ${version} (api ${api}), which the project compiles against...`);
          await downloadAndInstallSdk({ config, version, api, progress, logger });
          report = await build();
        }
      } catch (err) {
        // The build could not run at all (no command-line tools, not a project):
        // still one object on stdout for a caller that parses it.
        if (opts.json) {
          const error = err instanceof Error ? err.message : String(err);
          process.stdout.write(`${JSON.stringify({ ok: false, exitCode: 1, error, diagnostics: [] }, null, 2)}\n`);
        }
        throw err;
      }
      for (const w of report.warnings) logger.warn(w);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        const listed = formatDiagnostics(report.diagnostics);
        if (listed) logger.error(`Build failed${report.failedTask ? ` in ${report.failedTask}` : ''}:\n${listed}`);
        throw new OniroError(report.error ?? 'Build failed.');
      }
      logger.info('Build complete.');
    });
}

/** Diagnostics one per line, `file:line:col severity [code] message (rule)`, errors first, at most `max`. */
export function formatDiagnostics(diagnostics: readonly BuildDiagnostic[], max = 20): string {
  const sorted = [...diagnostics].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const lines = sorted.slice(0, max).map((d) => {
    const at = d.file ? `${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''} ` : '';
    return `  ${at}${d.severity} ${d.source}${d.code ? ` ${d.code}` : ''}: ${d.message}${d.rule ? ` (${d.rule})` : ''}`;
  });
  if (sorted.length > max) lines.push(`  … and ${sorted.length - max} more`);
  return lines.join('\n');
}
