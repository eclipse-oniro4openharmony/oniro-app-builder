import { Command } from 'commander';
import * as path from 'node:path';
import { captureLog } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface LogsOpts {
  output: string;
  for?: string;
  grep?: string;
  clear?: boolean;
  domain?: string;
  device?: string;
}

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description(
      'Capture hilog to a file for a whole session: the device\'s small log buffer wraps within ' +
        'seconds under chatty components, so a dump at the end loses lines. Runs until --for elapses ' +
        'or the process is interrupted; start it in the background, e.g. `oniro-app logs --clear -o ' +
        'hilog_full.txt &`. Every line is flushed as it arrives and the stream reconnects after a reboot.',
    )
    .requiredOption('-o, --output <file>', 'File to append the lines to.')
    .option('--for <ms>', 'Stop after this many ms (default: run until interrupted).')
    .option('--grep <regex>', 'Keep only lines matching this regex (default: all).')
    .option('--clear', 'Clear the device log buffer first (hilog -r), so the file covers only this session.')
    .option('--domain <domain>', 'hilog domain filter (e.g. 0xD003900).')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: LogsOpts) => {
      const { config, logger } = getRuntime();
      const file = path.resolve(opts.output);
      const abort = new AbortController();
      const stop = (): void => abort.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      logger.info(`Capturing hilog to ${file}${opts.for ? ` for ${opts.for} ms` : ' until interrupted'}...`);
      const result = await captureLog({
        config,
        file,
        durationMs: opts.for !== undefined ? Number(opts.for) : undefined,
        pattern: opts.grep ? new RegExp(opts.grep) : undefined,
        clear: opts.clear,
        domain: opts.domain,
        deviceSerial: opts.device,
        abortSignal: abort.signal,
        logger,
      });
      logger.info(`Wrote ${result.lines} lines to ${result.file} (${result.reconnects} reconnects).`);
      process.stdout.write(`${result.file}\n`);
    });
}
