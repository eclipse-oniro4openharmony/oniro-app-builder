import { Command } from 'commander';
import { waitForLog, waitForBoot, waitForBundle, waitForTarget, describeLayoutNode } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { addTargetOptions, selectorFrom, type TargetOpts } from '../lib/target.js';
import { parseSince } from '../lib/logSince.js';

interface WaitOpts extends TargetOpts {
  log?: string;
  since?: string;
  boot?: boolean;
  bundle?: string;
  pidOf?: string;
  domain?: string;
  gone?: boolean;
  interval: string;
  timeout: string;
  device?: string;
  json?: boolean;
}

export function registerWaitCommand(program: Command): void {
  const wait = program
    .command('wait')
    .description(
      'Wait for a device condition: a log line (--log), boot (--boot), a bundle to start (--bundle), ' +
        'or an on-screen element (--target / --target-id / --target-type).',
    )
    .option('--log <pattern>', 'Resolve when a hilog line (tag: message) logged after the command starts matches this regex.')
    .option(
      '--since <seconds>',
      'With --log: also match lines logged up to N seconds before the command started, ' +
        'measured on the device clock; "all" matches everything still in the device log buffer.',
    )
    .option('--boot', 'Resolve when the device is reachable (optionally also --pid-of).')
    .option('--bundle <bundle>', 'With --log: filter to this bundle. Alone: wait until this bundle is running.')
    .option('--pid-of <name>', 'With --boot: also require this process to have a pid.')
    .option('--domain <domain>', 'With --log: hilog domain filter (e.g. 0xD003900).');
  addTargetOptions(wait, 'Resolve when', { index: false });
  wait
    .option('--gone', 'With --target*: resolve when no uncovered element matches any more.')
    .option('--interval <ms>', 'With --target*: poll interval, ms (each poll is a layout dump).', '500')
    .option('--timeout <ms>', 'Max wait, ms.', '30000')
    .option('--device <serial>', 'Target device serial.')
    .option('--json', 'With --log or --target*: emit the matched entry/element as JSON.')
    .action(async (opts: WaitOpts) => {
      const { config, logger } = getRuntime();
      const timeoutMs = Number(opts.timeout);
      const selector = selectorFrom(opts);

      if (opts.log) {
        const entry = await waitForLog({
          config,
          pattern: new RegExp(opts.log),
          timeoutMs,
          bundle: opts.bundle,
          domain: opts.domain,
          deviceSerial: opts.device,
          lookbackMs: parseSince(opts.since),
          logger,
        });
        if (opts.json) process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
        else logger.info(`matched: ${entry.time}  ${entry.tag}: ${entry.message}`);
        return;
      }
      if (opts.boot) {
        await waitForBoot({ config, untilPidOf: opts.pidOf, timeoutMs, deviceSerial: opts.device, logger });
        logger.info('Device booted.');
        return;
      }
      if (selector) {
        const node = await waitForTarget({
          config,
          selector,
          gone: opts.gone,
          timeoutMs,
          pollMs: Number(opts.interval) || 500,
          deviceSerial: opts.device,
          logger,
        });
        if (!node) {
          logger.info('Element is gone.');
          return;
        }
        if (opts.json) process.stdout.write(`${JSON.stringify(node, null, 2)}\n`);
        else logger.info(`found: ${describeLayoutNode(node)}`);
        return;
      }
      if (opts.bundle) {
        await waitForBundle({ config, bundle: opts.bundle, timeoutMs, deviceSerial: opts.device, logger });
        logger.info(`Bundle ${opts.bundle} is running.`);
        return;
      }
      throw new Error('Specify one of --log <pattern>, --boot, --bundle <bundle>, or --target <text> (or --target-id / --target-type).');
    });
}
