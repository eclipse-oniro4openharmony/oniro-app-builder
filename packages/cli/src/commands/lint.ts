import { Command } from 'commander';
import * as path from 'node:path';
import { runCodelinter } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface LintOpts {
  files?: string[];
  json?: boolean;
}

export function registerLintCommand(program: Command): void {
  program
    .command('lint [project-dir]')
    .description('Run the OpenHarmony codelinter on a project. Defaults to the current directory.')
    .option('--files <globs...>', 'Specific files/globs to lint (default: the whole project).')
    .option('--json', 'Emit findings as JSON.')
    .action(async (projectDir: string | undefined, opts: LintOpts) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      const result = await runCodelinter({ config, projectDir: dir, files: opts.files, logger });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        for (const f of result.findings) {
          process.stdout.write(`${f.file}:${f.line} ${f.severity} ${f.message}${f.code ? ` [${f.code}]` : ''}\n`);
        }
        if (result.findings.length === 0) process.stdout.write('No findings.\n');
      }
      // Surface a non-zero codelinter exit to the caller (CI), but let output flush.
      if (result.code !== 0) process.exitCode = result.code;
    });
}
