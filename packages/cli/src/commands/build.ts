import { Command } from 'commander';
import * as path from 'node:path';
import { buildHap } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface BuildOpts {
  product: string;
  module?: string;
  mode?: string;
  task: string;
  deps: boolean;
  parallel: boolean;
  json?: boolean;
}

export function registerBuildCommand(program: Command): void {
  program
    .command('build [project-dir]')
    .description('Build an OpenHarmony app via hvigorw. Defaults to the current directory.')
    .option('--product <product>', 'hvigor product name', 'default')
    .option('--module <module>', 'restrict the build to a specific module')
    .option('--mode <mode>', 'hvigor build mode (e.g. release, debug)')
    .option('--task <task>', 'hvigor task to run', 'assembleHap')
    .option('--no-deps', 'skip the automatic `ohpm install --all` when oh_modules/ is missing')
    .option('--no-parallel', 'build modules serially (default: parallel)')
    .option('--json', 'emit the build result (discovered HAPs, warnings) as JSON')
    .action(async (projectDir: string | undefined, opts: BuildOpts) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      logger.info(`Building project at ${dir}...`);
      const result = await buildHap({
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
      for (const w of result.warnings) logger.warn(w);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
      logger.info('Build complete.');
    });
}
