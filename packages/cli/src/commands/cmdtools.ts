import { Command } from 'commander';
import { getCmdToolsStatus, installCmdTools, isCmdToolsInstalled, removeCmdTools } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerCmdToolsCommand(program: Command): void {
  const cmdtools = program.command('cmdtools').description('Manage OpenHarmony command-line tools.');

  cmdtools
    .command('install')
    .description('Install the OpenHarmony command-line tools (hvigorw, ohpm, hdc). Skips if already installed.')
    .option('--from-zip <path>', 'Install from a local ZIP instead of downloading.')
    .option('--force', 'Reinstall even if the tools are already present.')
    .action(async (opts: { fromZip?: string; force?: boolean }) => {
      const { config, logger, progress } = getRuntime();
      if (isCmdToolsInstalled(config) && !opts.force) {
        logger.info('Command-line tools already installed; pass --force to reinstall.');
        return;
      }
      logger.info('Installing OpenHarmony command-line tools...');
      await installCmdTools({ config, progress, logger, localZipPath: opts.fromZip });
      logger.info('Command-line tools installed.');
    });

  cmdtools
    .command('status')
    .description('Report whether the command-line tools are installed and their version.')
    .option('--json', 'Emit machine-readable JSON.')
    .action((opts: { json?: boolean }) => {
      const { config } = getRuntime();
      const status = getCmdToolsStatus(config);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${status.status}\n`);
      if (!status.installed) process.exit(1);
    });

  cmdtools
    .command('remove')
    .description('Delete the configured command-line tools directory.')
    .action(() => {
      const { config, logger } = getRuntime();
      removeCmdTools(config);
      logger.info('Command-line tools removed.');
    });
}
