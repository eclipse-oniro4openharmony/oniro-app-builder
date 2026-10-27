import { Command } from 'commander';
import { dumpLayout } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { formatFlatLayout } from '../lib/layoutText.js';

interface DumpOpts {
  bundle?: string;
  raw?: boolean;
  flat?: boolean;
  device?: string;
}

export function registerDumpCommand(program: Command): void {
  program
    .command('dump [target]')
    .description(
      'Dump device state. Currently supports `dump layout` (the default target): JSON by default, ' +
        'or one line per element with --flat.',
    )
    .option('--bundle <bundle>', 'Filter the layout to a single window/bundle.')
    .option('--raw', 'Return the unpruned layout tree.')
    .option('--flat', 'One line per element (type, label, center as 0-1 fractions, flags) instead of a JSON tree.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (target: string | undefined, opts: DumpOpts) => {
      const { config, logger } = getRuntime();
      const what = target ?? 'layout';
      if (what !== 'layout') throw new Error(`Unknown dump target "${what}". Supported: layout.`);
      if (opts.raw && opts.flat) throw new Error('--raw and --flat cannot be combined.');
      const result = await dumpLayout({
        config,
        bundleName: opts.bundle,
        prune: !opts.raw,
        detectKeyboard: !opts.raw,
        deviceSerial: opts.device,
        logger,
      });
      process.stdout.write(opts.flat ? formatFlatLayout(result) : `${JSON.stringify(result, null, 2)}\n`);
    });
}
