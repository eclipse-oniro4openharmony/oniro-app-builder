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
    .description('Start the Oniro emulator via the bundled launcher (run.sh / run.bat). Detaches so the CLI can exit while the emulator keeps running.')
    .option('--headless', 'Launch headless (VNC + telnet serial, no local window). Required in CI.')
    .option('--log <path>', 'Redirect launcher stdout/stderr to this file. Defaults to discarding output.')
    .option('--wait-for-hdc <seconds>', 'Wait up to N seconds for hdc to connect. 0 = do not wait.', (v) => parseInt(v, 10), 0)
    .option('--connect <host:port>', 'Override the launcher\'s hdc port-forward bind address. Pass 0.0.0.0:55555 on hosts where QEMU refuses to bind 127.0.0.1 (some CI runners).')
    .action(async (opts: { headless?: boolean; log?: string; waitForHdc: number; connect?: string }) => {
      const { config, logger } = getRuntime();
      await startEmulator({
        config,
        logger,
        headless: opts.headless === true,
        logFile: opts.log,
        waitForHdcSeconds: opts.waitForHdc,
        connect: opts.connect,
      });
      logger.info('Emulator start command complete.');
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
