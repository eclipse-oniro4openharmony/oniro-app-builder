import { Command } from 'commander';
import { dumpLayout } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface DumpOpts {
  bundle?: string;
  raw?: boolean;
  device?: string;
}

export function registerDumpCommand(program: Command): void {
  program
    .command('dump [target]')
    .description('Dump device state as JSON. Currently supports `dump layout` (the default target).')
    .option('--bundle <bundle>', 'Filter the layout to a single window/bundle.')
    .option('--raw', 'Return the unpruned layout tree.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (target: string | undefined, opts: DumpOpts) => {
      const { config, logger } = getRuntime();
      const what = target ?? 'layout';
      if (what !== 'layout') throw new Error(`Unknown dump target "${what}". Supported: layout.`);
      const result = await dumpLayout({
        config,
        bundleName: opts.bundle,
        prune: !opts.raw,
        deviceSerial: opts.device,
        logger,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
}
