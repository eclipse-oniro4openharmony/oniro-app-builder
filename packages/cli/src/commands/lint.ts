import { Command, InvalidArgumentError } from 'commander';
import * as path from 'node:path';
import {
  detectCmdToolsFlavour,
  detectRuntimeOs,
  getCmdToolsPath,
  missingProjectRootFiles,
  runCodelinter,
  type CodelinterResult,
  type CodelinterSummary,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { runArktsCheckCommand } from './check.js';

interface LintOpts {
  files?: string[];
  json?: boolean;
  engine: string;
  allowIncomplete?: boolean;
}

/** codelinter's totals, or totals counted from the findings when it printed none. */
export function lintTotals(result: Pick<CodelinterResult, 'findings' | 'summary'>): CodelinterSummary {
  if (result.summary) return result.summary;
  const count = (s: string): number => result.findings.filter((f) => f.severity === s).length;
  return {
    defects: result.findings.length,
    errors: count('error'),
    warnings: count('warning'),
    suggestions: count('suggestion'),
  };
}

/**
 * The exit code for a lint run: 1 when there is an error-severity finding, or when
 * codelinter exited non-zero without printing a report (so it did not really run);
 * 2 when codelinter said its report is incomplete (it skipped checks, so a clean
 * report means nothing), unless `allowIncomplete`. Warnings and suggestions alone
 * exit 0, although codelinter itself exits 1 for them.
 */
export function lintExitCode(
  result: Pick<CodelinterResult, 'code' | 'findings' | 'summary' | 'incomplete'>,
  allowIncomplete = false,
): number {
  if (lintTotals(result).errors > 0) return 1;
  if (lintFailed(result)) return result.code;
  return result.incomplete && !allowIncomplete ? 2 : 0;
}

/** True when codelinter exited non-zero without printing a report, so it did not really run. */
export function lintFailed(result: Pick<CodelinterResult, 'code' | 'findings' | 'summary'>): boolean {
  return result.summary === null && result.findings.length === 0 && result.code !== 0;
}

export function registerLintCommand(program: Command): void {
  program
    .command('lint [project-dir]')
    .description(
      'Run the OpenHarmony codelinter on a project. Defaults to the current directory. ' +
        'Exits 1 on error-severity findings or when codelinter fails to run, 2 when codelinter reports that it ' +
        'skipped checks (incomplete), 0 otherwise; warnings alone exit 0. `--engine arkts` runs `check arkts` instead.',
    )
    .option('--files <globs...>', 'Specific files/globs to lint (default: the whole project).')
    .option('--json', 'Emit the report (findings, summary, notices, incomplete) as JSON.')
    .option(
      '--engine <engine>',
      '`codelinter`, or `arkts` for the ArkTS checker of `check arkts` (same options, report and exit codes).',
      'codelinter',
    )
    .option(
      '--allow-incomplete',
      'Exit 0 rather than 2 when codelinter reports that it skipped checks (e.g. the tools flavour differs from runtimeOS).',
    )
    .action(async (projectDir: string | undefined, opts: LintOpts) => {
      if (opts.engine === 'arkts') {
        process.exitCode = await runArktsCheckCommand(projectDir, { files: opts.files, json: opts.json });
        return;
      }
      if (opts.engine !== 'codelinter') {
        throw new InvalidArgumentError(`Unknown --engine ${opts.engine}: use codelinter or arkts.`);
      }
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      const result = await runCodelinter({ config, projectDir: dir, files: opts.files, logger });
      const totals = lintTotals(result);
      const failed = lintFailed(result);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (!failed) {
        for (const f of result.findings) {
          const at = `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}`;
          process.stdout.write(`${at} ${f.severity} ${f.message}${f.code ? ` [${f.code}]` : ''}\n`);
        }
        process.stdout.write(
          totals.defects === 0
            ? 'No defects found.\n'
            : `${totals.defects} defects: ${totals.errors} errors, ${totals.warnings} warnings, ` +
                `${totals.suggestions} suggestions.\n`,
        );
      }

      if (failed) {
        const missing = missingProjectRootFiles(dir);
        const why = missing.length ? ` It needs a DevEco project root, and ${dir} has no ${missing.join(', ')}.` : '';
        logger.error(
          `codelinter exited ${result.code} without a report, so nothing was linted.${why}\n` +
            result.raw.trim().split('\n').slice(-15).join('\n'),
        );
      }
      if (result.incomplete) {
        for (const n of result.notices) logger.warn(`codelinter: ${n}`);
        const cmdToolsPath = getCmdToolsPath(config);
        const flavour = detectCmdToolsFlavour(cmdToolsPath);
        const projectOs = detectRuntimeOs(dir);
        if (flavour !== projectOs) {
          logger.warn(
            `The command-line tools at ${cmdToolsPath} are the ${flavour} flavour, but the project targets ` +
              `${projectOs} (runtimeOS in build-profile.json5), so codelinter skipped part of its checks: treat the ` +
              `counts as a lower bound. For a complete report, point ONIRO_CMD_TOOLS_PATH at ${projectOs} ` +
              "command-line tools. The build's ArkTS compiler checks are not affected.",
          );
        }
      }
      // Let output flush before exiting non-zero.
      if (result.incomplete && !opts.allowIncomplete && lintTotals(result).errors === 0 && !failed) {
        logger.error(
          'codelinter reported an incomplete run, so a clean result is not evidence the code is clean: exiting 2. ' +
            'Pass --allow-incomplete to exit 0, or use `oniro-app check arkts`, which does not depend on codelinter.',
        );
      }
      process.exitCode = lintExitCode(result, opts.allowIncomplete);
    });
}
