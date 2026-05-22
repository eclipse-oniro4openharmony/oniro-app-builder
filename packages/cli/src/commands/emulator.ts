import { Command } from 'commander';
import {
  attemptHdcConnection,
  installEmulator,
  isEmulatorInstalled,
  removeEmulator,
  startEmulator,
  stopEmulator,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerEmulatorCommand(program: Command): void {
  const emu = program.command('emulator').description('Manage the Oniro emulator.');

  emu
    .command('install')
    .description('Download and install the Oniro emulator (QEMU-based). Skips if already installed.')
    .option('--force', 'Reinstall even if the emulator is already present.')
    .action(async (opts: { force?: boolean }) => {
      const { config, logger, progress } = getRuntime();
      if (isEmulatorInstalled(config) && !opts.force) {
        logger.info('Emulator already installed; pass --force to reinstall.');
        return;
      }
      logger.info('Installing Oniro emulator...');
      await installEmulator({ config, progress, logger });
      logger.info('Emulator installed.');
    });

  emu
    .command('start')
    .description('Start the emulator and (by default) wait for hdc to connect.')
    .option('--no-wait', 'Return as soon as the emulator process is launched, without waiting for hdc.')
    .action(async (opts: { wait: boolean }) => {
      const { config, logger } = getRuntime();
      await startEmulator({ config, logger, waitForHdc: opts.wait });
      logger.info('Emulator started.');
    });

  emu
    .command('stop')
    .description('Kill running emulator processes.')
    .action(async () => {
      const { logger } = getRuntime();
      await stopEmulator(logger);
      logger.info('Emulator stopped.');
    });

  emu
    .command('connect')
    .description('Attempt to connect hdc to the emulator.')
    .option('--address <addr>', 'hdc address to connect to', '127.0.0.1:55555')
    .action(async (opts: { address: string }) => {
      const { config, logger } = getRuntime();
      const ok = await attemptHdcConnection(config, opts.address, logger);
      if (!ok) {
        logger.error(`Could not connect hdc to ${opts.address}.`);
        process.exit(1);
      }
      logger.info(`hdc connected to ${opts.address}.`);
    });

  emu
    .command('remove')
    .description('Delete the configured emulator directory.')
    .action(() => {
      const { config, logger } = getRuntime();
      removeEmulator(config);
      logger.info('Emulator removed.');
    });
}
