import { Command } from 'commander';
import {
  describeCmdTools,
  getCmdToolsStatus,
  installCmdTools,
  isCmdToolsInstalled,
  removeCmdTools,
  type CmdToolsSdk,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

/** `HarmonyOS 6.1.1, API 24 (6.1.1.125) at <path>`, leaving out what is unknown. */
export function formatCmdToolsSdk(sdk: CmdToolsSdk): string {
  const name = [sdk.displayName, sdk.apiVersion ? `API ${sdk.apiVersion}` : undefined].filter(Boolean).join(', ');
  return `${name || 'SDK'}${sdk.build ? ` (${sdk.build})` : ''} at ${sdk.path}`;
}

export function registerCmdToolsCommand(program: Command): void {
  const cmdtools = program
    .command('cmdtools')
    .description(
      'Manage the command-line tools (hvigorw, ohpm, codelinter, hdc). Their HarmonyOS edition also supplies ' +
        'the HarmonyOS SDK, which `sdk` does not manage.',
    );

  cmdtools
    .command('install')
    .description(
      'Install the command-line tools (hvigorw, ohpm, codelinter, hdc and, in the HarmonyOS edition, the ' +
        'HarmonyOS SDK). Skips if already installed.',
    )
    .option('--from-zip <path>', 'Install from a local ZIP instead of downloading.')
    .option('--force', 'Reinstall even if the tools are already present.')
    .option(
      '--tmp-dir <path>',
      'Directory for download/extract temporaries (default: ONIRO_TMP_DIR, else .oniro-tmp next to ' +
        'the install target). Use this when that filesystem is short on space.',
    )
    .action(async (opts: { fromZip?: string; force?: boolean; tmpDir?: string }) => {
      const { config, logger, progress } = getRuntime();
      if (isCmdToolsInstalled(config) && !opts.force) {
        logger.info('Command-line tools already installed; pass --force to reinstall.');
        return;
      }
      logger.info('Installing command-line tools...');
      await installCmdTools({ config, progress, logger, localZipPath: opts.fromZip, tmpDir: opts.tmpDir });
      logger.info('Command-line tools installed.');
    });

  cmdtools
    .command('status')
    .description(
      'Report whether the command-line tools are installed, their version, flavour (HarmonyOS or ' +
        'OpenHarmony), the SDK they bundle (name, API level), their tools\' versions (hvigor, ohpm, ...), ' +
        'and the hdc binary every device command uses.',
    )
    .option('--json', 'Emit machine-readable JSON.')
    .action((opts: { json?: boolean }) => {
      const { config } = getRuntime();
      const status = getCmdToolsStatus(config);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${status.version ? `Installed ${describeCmdTools(status)}` : status.status}\n`);
      process.stdout.write(`path:    ${status.path}\n`);
      if (status.flavour) process.stdout.write(`flavour: ${status.flavour}\n`);
      if (status.sdk) process.stdout.write(`sdk:     ${formatCmdToolsSdk(status.sdk)}\n`);
      if (status.tools?.hvigor) process.stdout.write(`hvigor:  ${status.tools.hvigor}\n`);
      process.stdout.write(`hdc:     ${status.hdc.path}${status.hdc.exists ? '' : ' (missing)'}\n`);
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
