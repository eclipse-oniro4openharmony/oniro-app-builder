import { Command } from 'commander';
import * as path from 'node:path';
import { checkArkts, type ArktsCheckReport } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { formatDiagnostics } from './build.js';

export interface ArktsCheckCommandOpts {
  files?: string[];
  fix?: boolean;
  sdk?: string;
  json?: boolean;
}

/** 0 when the check ran clean, 1 when it found an error, 2 when it could not run, so nothing is known. */
export function arktsCheckExitCode(report: Pick<ArktsCheckReport, 'completed' | 'ok'>): number {
  if (!report.completed) return 2;
  return report.ok ? 0 : 1;
}

/** The closing line of a text report. */
export function arktsCheckSummaryLine(report: Pick<ArktsCheckReport, 'summary' | 'durationMs'>): string {
  const s = report.summary;
  const fixed = s.fixed ? `, ${s.fixed} fixed` : '';
  return `${s.errors} errors, ${s.warnings} warnings${fixed} in ${s.files} files (${(report.durationMs / 1000).toFixed(1)} s).`;
}

/** Run `check arkts` and print its report; returns the exit code. Shared with `lint --engine arkts`. */
export async function runArktsCheckCommand(projectDir: string | undefined, opts: ArktsCheckCommandOpts): Promise<number> {
  const { config, logger } = getRuntime();
  const dir = path.resolve(projectDir ?? process.cwd());
  let report: ArktsCheckReport;
  try {
    report = await checkArkts({ config, projectDir: dir, files: opts.files, fix: opts.fix, sdkDir: opts.sdk, logger });
  } catch (err) {
    // The check could not start (not a project, SDK not installed): still one
    // object on stdout for a caller that parses it, and exit 2 since nothing was checked.
    const error = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, completed: false, error, diagnostics: [] }, null, 2)}\n`);
    }
    logger.error(error);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.completed) {
    if (report.diagnostics.length) process.stdout.write(`${formatDiagnostics(report.diagnostics, Infinity)}\n`);
    for (const d of report.fixed) {
      process.stdout.write(`  fixed ${d.file}:${d.line}:${d.column} ${d.message}\n`);
    }
    if (report.alsoModified.length) {
      process.stdout.write(`--fix also edited: ${report.alsoModified.join(', ')}\n`);
    }
    process.stdout.write(`${arktsCheckSummaryLine(report)}\n`);
  }
  if (!report.completed) logger.error(report.error ?? 'The ArkTS checker did not complete, so nothing was checked.');
  return arktsCheckExitCode(report);
}

export function registerCheckCommand(program: Command): void {
  const check = program
    .command('check')
    .description('Static checks that need no build and no device.');

  check
    .command('arkts [project-dir]')
    .description(
      "Type-check and lint ArkTS with the SDK's own ArkTS checker (what the build's CompileArkTS runs), plus the " +
        'ArkUI component-model and project-config rules the build enforces later (V1/V2 decorators, @Entry root, ' +
        'route maps, resources, permissions), in seconds and without a build. Uses the SDK the project compiles ' +
        'with. Exits 0 when clean, 1 on an error, 2 when the checker could not run (then nothing is known).',
    )
    .option(
      '--files <files...>',
      'Check only these .ets files (project-wide rules such as main_pages.json and module.json5 are then skipped).',
    )
    .option(
      '--fix',
      "Apply the fixes the checker can verify (the compiler's `Did you mean` suggestions, import paths, a missing " +
        '`export`, the @Component/@ComponentV2 decorator), re-check, and revert any fix that adds an error.',
    )
    .option('--sdk <dir>', 'SDK directory to check against (holding ets/), instead of the one compileSdkVersion names.')
    .option(
      '--json',
      'Print the report as JSON: ok, completed, diagnostics (severity, source, rule, message, file, line, column), ' +
        'fixed, alsoModified, summary, sdk, durationMs, error.',
    )
    .action(async (projectDir: string | undefined, opts: ArktsCheckCommandOpts) => {
      process.exitCode = await runArktsCheckCommand(projectDir, opts);
    });
}
