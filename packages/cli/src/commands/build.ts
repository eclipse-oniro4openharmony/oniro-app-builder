import { Command } from 'commander';
import * as path from 'node:path';
import { runHvigorw } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerBuildCommand(program: Command): void {
  program
    .command('build [project-dir]')
    .description('Build an OpenHarmony app via hvigorw. Defaults to the current directory.')
    .option('--product <product>', 'hvigor product name', 'default')
    .option('--module <module>', 'restrict the build to a specific module')
    .option('--mode <mode>', 'hvigor build mode (e.g. release, debug)')
    .option('--task <task>', 'hvigor task to run', 'assembleHap')
    .action(async (projectDir: string | undefined, opts: { product: string; module?: string; mode?: string; task: string }) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      logger.info(`Building project at ${dir}...`);
      await runHvigorw({
        config,
        projectDir: dir,
        product: opts.product,
        module: opts.module,
        buildMode: opts.mode,
        task: opts.task,
        logger,
        // Forward output as it arrives. We don't double-print since the logger
        // already echoes spawn output; this hook is for streaming to other UIs.
        onOutput: () => {},
      });
      logger.info('Build complete.');
    });
}
