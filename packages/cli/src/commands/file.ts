import { Command } from 'commander';
import { sendFile, recvFile } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerFileCommand(program: Command): void {
  const file = program.command('file').description('Transfer files to/from the device (hdc file send/recv).');

  file
    .command('send <local> <remote>')
    .description(
      'Push a local file to the device. With --bundle, <remote> may be relative to that app\'s sandbox ' +
        '(files/x is its filesDir, haps/entry/files/x the entry module\'s), and the file is chowned to the app ' +
        'so it can read it. Prints the device path.',
    )
    .option('--bundle <bundle>', 'Push into this app\'s sandbox and give the file to the app\'s user.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (local: string, remote: string, opts: { bundle?: string; device?: string }) => {
      const { config, logger } = getRuntime();
      const written = await sendFile({ config, local, remote, bundle: opts.bundle, deviceSerial: opts.device, logger });
      logger.info(`Sent ${local} -> ${written}${opts.bundle ? ` (owned by ${opts.bundle})` : ''}.`);
      process.stdout.write(`${written}\n`);
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
