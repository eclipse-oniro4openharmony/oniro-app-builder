import { Command } from 'commander';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureLog } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { collectLogBundle } from '../lib/logBundle.js';

interface LogsOpts {
  output?: string;
  for?: string;
  grep?: string;
  clear?: boolean;
  domain?: string;
  device?: string;
}

interface CollectOptions {
  output: string;
  device?: string;
  package?: string;
  pid?: string;
  tag?: string;
  level?: string;
  duration: string;
  redact: boolean;
  json?: boolean;
}

export function registerLogsCommand(program: Command): void {
  const logs = program
    .command('logs')
    .description(
      'Capture hilog to a file for a whole session: the device\'s small log buffer wraps within ' +
        'seconds under chatty components, so a dump at the end loses lines. Runs until --for elapses ' +
        'or the process is interrupted; start it in the background, e.g. `oniro-app logs --clear -o ' +
        'hilog_full.txt &`. Every line is flushed as it arrives and the stream reconnects after a reboot.',
    )
    // Not requiredOption: commander checks a parent's mandatory options for its
    // subcommands too, so `logs collect` would demand it.
    .option('-o, --output <file>', 'File to append the lines to (required).')
    .option('--for <ms>', 'Stop after this many ms (default: run until interrupted).')
    .option('--grep <regex>', 'Keep only lines matching this regex (default: all).')
    .option('--clear', 'Clear the device log buffer first (hilog -r), so the file covers only this session.')
    .option('--domain <domain>', 'hilog domain filter (e.g. 0xD003900).')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: LogsOpts) => {
      if (!opts.output) logs.error("error: required option '-o, --output <file>' not specified");
      const { config, logger } = getRuntime();
      const file = path.resolve(opts.output!);
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

  logs
    .command('collect')
    .description('Create a diagnostic bundle from a connected device.')
    .allowExcessArguments(false)
    .option('-o, --output <directory>', 'Parent directory for incident bundles.', path.join(os.homedir(), '.oniro', 'incident-bundles'))
    .option('--device <serial>', 'Target device serial.')
    .option('--package <bundle>', 'Collect faultlog entries for this application bundle.')
    .option('--pid <pid>', 'Create a filtered HiLog view for this process.')
    .option('--tag <tag>', 'Create a filtered HiLog view for this tag.')
    .option('--level <level>', 'Create a filtered HiLog view for this level (V/D/I/W/E/F).')
    .option('--duration <seconds>', 'Keep HiLog records from the last N seconds (default 600).', '600')
    .option('--redact', 'Redact sensitive values and archive only the redacted bundle.')
    .option('--json', 'Emit bundle paths and status as JSON.')
    .action(async (opts: CollectOptions) => {
      const { config } = getRuntime();
      const result = await collectLogBundle({
        config,
        outputDirectory: opts.output,
        deviceSerial: opts.device,
        packageName: opts.package,
        pid: opts.pid,
        tag: opts.tag,
        level: opts.level,
        durationSeconds: Number(opts.duration),
        redact: Boolean(opts.redact),
      });
      const output = opts.json
        ? `${JSON.stringify({ ...result, status: result.complete ? 'complete' : 'partial' }, null, 2)}\n`
        : `${result.archivePath ?? result.bundleDirectory}\n`;
      process.stdout.write(output);
      if (!result.complete) {
        throw new Error(`Bundle is partial; inspect manifest.json. ${result.error ?? 'One or more collectors failed.'}`);
      }
    });
}
