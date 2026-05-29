import { Command } from 'commander';
import { watchLog } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface WatchOpts {
  log?: string;
  for: string;
  bundle?: string;
  domain?: string;
  dedup: boolean;
  device?: string;
  json?: boolean;
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Collect hilog lines matching a pattern for a fixed duration.')
    .option('--log <pattern>', 'Regex tested against each line (tag: message).')
    .option('--for <ms>', 'Duration to watch, ms.', '10000')
    .option('--bundle <bundle>', 'Filter to this bundle.')
    .option('--domain <domain>', 'hilog domain filter (e.g. 0xD003900).')
    .option('--no-dedup', 'Do not collapse consecutive duplicate lines.')
    .option('--device <serial>', 'Target device serial.')
    .option('--json', 'Emit the entries as JSON.')
    .action(async (opts: WatchOpts) => {
      const { config, logger } = getRuntime();
      if (!opts.log) throw new Error('watch requires --log <pattern>.');
      const entries = await watchLog({
        config,
        pattern: new RegExp(opts.log),
        durationMs: Number(opts.for),
        bundle: opts.bundle,
        domain: opts.domain,
        dedup: opts.dedup,
        deviceSerial: opts.device,
        logger,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
      } else {
        for (const e of entries) process.stdout.write(`${e.time}  ${e.level}  ${e.tag}: ${e.message}\n`);
      }
    });
}
