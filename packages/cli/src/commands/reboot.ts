import { Command, Option } from 'commander';
import { reboot } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerRebootCommand(program: Command): void {
  program
    .command('reboot')
    .description('Reboot the connected device/emulator.')
    .addOption(
      new Option('--mode <mode>', 'Reboot target.').choices(['system', 'bootloader', 'recovery']).default('system'),
    )
    .option('--wait-bundle <bundle>', 'After a system reboot, wait until this bundle is running again.')
    .option('--timeout <ms>', 'Max time to wait for the bundle, ms.', '180000')
    .option('--device <serial>', 'Target device serial.')
    .action(
      async (opts: {
        mode: 'system' | 'bootloader' | 'recovery';
        waitBundle?: string;
        timeout: string;
        device?: string;
      }) => {
        const { config, logger } = getRuntime();
        logger.info(`Rebooting device (${opts.mode})...`);
        await reboot({
          config,
          mode: opts.mode,
          waitForBundle: opts.waitBundle,
          timeoutMs: Number(opts.timeout),
          deviceSerial: opts.device,
          logger,
        });
        logger.info('Reboot complete.');
      },
    );
}
