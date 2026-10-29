import { Command } from 'commander';
import * as path from 'node:path';
import {
  detectCmdToolsFlavour,
  detectRuntimeOs,
  getCmdToolsPath,
  runCodelinter,
  type CodelinterResult,
  type CodelinterSummary,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface LintOpts {
  files?: string[];
  json?: boolean;
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
 * codelinter exited non-zero without printing a report (so it did not really run).
 * Warnings and suggestions alone exit 0, although codelinter itself exits 1 for them.
 */
export function lintExitCode(result: Pick<CodelinterResult, 'code' | 'findings' | 'summary'>): number {
  if (lintTotals(result).errors > 0) return 1;
  const noReport = result.summary === null && result.findings.length === 0;
  return noReport && result.code !== 0 ? result.code : 0;
}

export function registerLintCommand(program: Command): void {
  program
    .command('lint [project-dir]')
    .description(
      'Run the OpenHarmony codelinter on a project. Defaults to the current directory. ' +
        'Exits 1 on error-severity findings or when codelinter fails to run; warnings alone exit 0.',
    )
    .option('--files <globs...>', 'Specific files/globs to lint (default: the whole project).')
    .option('--json', 'Emit the report (findings, summary, notices, incomplete) as JSON.')
    .action(async (projectDir: string | undefined, opts: LintOpts) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      const result = await runCodelinter({ config, projectDir: dir, files: opts.files, logger });
      const totals = lintTotals(result);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
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

      if (result.summary === null && result.findings.length === 0 && result.code !== 0) {
        logger.error(`codelinter exited ${result.code} without a report:\n${result.raw.trim().split('\n').slice(-15).join('\n')}`);
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
      process.exitCode = lintExitCode(result);
    });
}
