import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeFaultLog, captureLog, latestCrash, type CrashVerdict } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { collectLogBundle } from '../lib/logBundle.js';
import { formatCrashVerdict, parseCrashSince, projectBundle } from '../lib/crashReport.js';

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

interface CrashOptions {
  bundle?: string;
  since?: string;
  wait?: string;
  path?: string;
  output: string;
  device?: string;
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

  logs
    .command('crash')
    .description(
      "Fetch the newest faultlog of an app from the device and say what happened: a native crash (cpp_crash), " +
        'an uncaught ArkTS/JS error (js_crash), a freeze (app_freeze), or none. Reports the reason, the top frame, ' +
        'the first frame in the project\'s own code with file:line:column, the JS error and its stack, the native ' +
        'frames and, for a freeze, the binder chain. The bundle defaults to the project in the current directory, ' +
        'else any app. Lists through `hidumper -s 1201 -a "-p Faultlogger"`, and also reads faultloggerd\'s native ' +
        'crash records that hiview did not turn into a faultlog. Exits 0 whether or not there was a crash; check `crashed`.',
    )
    .allowExcessArguments(false)
    .option('--bundle <bundle>', 'App to look for (default: the bundleName of the project in the current directory, else any process).')
    .option('--since <s|ISO>', 'Only faults from the last N seconds (device clock), or since an ISO 8601 time.')
    .option('--wait <ms>', 'Keep looking this long when there is no fault yet; hiview writes the faultlog a few seconds after the process dies (default: look once).')
    .option('--path <file>', 'Analyse this local faultlog (or faultloggerd .json crash record) instead of fetching one.')
    .option('-o, --output <directory>', 'Where to save the fetched faultlog.', path.join(os.homedir(), '.oniro', 'faultlogs'))
    .option('--device <serial>', 'Target device serial.')
    .option(
      '--json',
      'Print the verdict as JSON: crashed, kind, subtype, confidence, bundle, pid, time, reason, topFrame, projectFrame, ' +
        'file, line, column, jsError {name, message, stack}, stack, nativeFrames, jsFrames, binderChain, deadlocks, notes, name, path, rawPath.',
    )
    .action(async (opts: CrashOptions) => {
      const since = parseCrashSince(opts.since);
      const waitMs = opts.wait !== undefined ? Number(opts.wait) : 0;
      if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`--wait takes a number of milliseconds, not "${opts.wait}".`);
      let verdict: CrashVerdict | null;
      const bundle = opts.bundle ?? (opts.path ? undefined : projectBundle(process.cwd()));
      if (opts.path) {
        const file = path.resolve(opts.path);
        verdict = analyzeFaultLog(await fs.readFile(file, 'utf8'), { name: path.basename(file), path: file, rawPath: file });
      } else {
        const { config, logger } = getRuntime();
        logger.info(`Looking for the newest fault of ${bundle ?? 'any process'}${opts.since ? ` since ${opts.since}` : ''}...`);
        verdict = await latestCrash({ config, bundle, since, waitMs, deviceSerial: opts.device, saveDir: opts.output, logger });
      }
      if (opts.json) {
        const none = { crashed: false, kind: null, bundle: bundle ?? null, since: since instanceof Date ? since.toISOString() : since ?? null };
        process.stdout.write(`${JSON.stringify(verdict ?? none, null, 2)}\n`);
      } else {
        process.stdout.write(verdict ? formatCrashVerdict(verdict) : `No fault for ${bundle ?? 'any process'}${opts.since ? ` since ${opts.since}` : ''}.\n`);
      }
    });
}
