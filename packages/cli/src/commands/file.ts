import { Command } from 'commander';
import { sendFile, recvFile } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerFileCommand(program: Command): void {
  const file = program.command('file').description('Transfer files to/from the device (hdc file send/recv).');

  file
    .command('send <local> <remote>')
    .description('Push a local file to the device.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (local: string, remote: string, opts: { device?: string }) => {
      const { config, logger } = getRuntime();
      await sendFile({ config, local, remote, deviceSerial: opts.device, logger });
      logger.info(`Sent ${local} -> ${remote}.`);
    });

  file
    .command('recv <remote> <local>')
    .description('Pull a file from the device.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (remote: string, local: string, opts: { device?: string }) => {
      const { config, logger } = getRuntime();
      await recvFile({ config, remote, local, deviceSerial: opts.device, logger });
      logger.info(`Received ${remote} -> ${local}.`);
    });
}
