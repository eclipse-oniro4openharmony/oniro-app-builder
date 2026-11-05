import { Command, InvalidArgumentError } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatFlow, recordFlow } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface RecordOpts {
  out: string;
  for?: number;
  bundle?: string;
  wake: boolean;
  device?: string;
  json?: boolean;
  raw?: string;
}

function positiveMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('Expected a positive number of milliseconds.');
  return Math.floor(n);
}

export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description(
      "Record what is done on the device into a flow file for `replay`. Runs uitest's recorder " +
        '(`uitest uiRecord record -l`), which logs every tap, swipe and key with the widget under the finger and ' +
        'dumps the layout after each one; each event becomes a step with the most specific stable selector for that ' +
        'widget in the layout on screen when it happened, a fallback point, and an `expect` element that appeared ' +
        'after it. Typing collapses into one inputText step per field. Stops on Ctrl+C or after --for.',
    )
    .requiredOption('--out <file>', 'Where to write the flow (JSON).')
    .option('--for <ms>', 'Stop after this long instead of waiting for Ctrl+C.', positiveMs)
    .option('--bundle <bundle>', 'The app being recorded (default: the foreground app when recording starts).')
    .option('--no-wake', 'Leave the screen as it is (by default it is turned on, a lock screen without a credential is swiped away, and it is kept on while recording).')
    .option('--raw <dir>', "Also keep uitest's raw recording (events, layouts, touch times) in this directory, for bug reports.")
    .option('--device <serial>', 'Target device serial.')
    .option('--json', 'Print {out, steps, events, warnings} as JSON.')
    .action(async (opts: RecordOpts) => {
      const { config, logger } = getRuntime();
      const controller = new AbortController();
      const onSigint = (): void => {
        if (controller.signal.aborted) process.exit(130);
        logger.info('stopping the recorder…');
        controller.abort();
      };
      process.on('SIGINT', onSigint);
      try {
        const result = await recordFlow({
          config,
          durationMs: opts.for,
          abortSignal: controller.signal,
          bundle: opts.bundle,
          wake: opts.wake,
          rawDir: opts.raw,
          deviceSerial: opts.device,
          logger,
          onEvents: (n) => logger.info(`${n} event line(s) recorded`),
        });
        const out = path.resolve(opts.out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, formatFlow(result.flow));
        for (const w of result.warnings) logger.warn(w);
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ out, steps: result.flow.steps.length, events: result.events, warnings: result.warnings }, null, 2)}\n`,
          );
        } else {
          process.stdout.write(`Wrote ${result.flow.steps.length} step(s) to ${out}.\n`);
        }
      } finally {
        process.off('SIGINT', onSigint);
      }
    });
}
