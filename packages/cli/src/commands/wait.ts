import { Command } from 'commander';
import { waitForLog, waitForBoot, waitForBundle } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface WaitOpts {
  log?: string;
  boot?: boolean;
  bundle?: string;
  pidOf?: string;
  domain?: string;
  timeout: string;
  device?: string;
  json?: boolean;
}

export function registerWaitCommand(program: Command): void {
  program
    .command('wait')
    .description('Wait for a device condition: a log line (--log), boot (--boot), or a bundle to start (--bundle).')
    .option('--log <pattern>', 'Resolve when a hilog line (tag: message) matches this regex.')
    .option('--boot', 'Resolve when the device is reachable (optionally also --pid-of).')
    .option('--bundle <bundle>', 'With --log: filter to this bundle. Alone: wait until this bundle is running.')
    .option('--pid-of <name>', 'With --boot: also require this process to have a pid.')
    .option('--domain <domain>', 'With --log: hilog domain filter (e.g. 0xD003900).')
    .option('--timeout <ms>', 'Max wait, ms.', '30000')
    .option('--device <serial>', 'Target device serial.')
    .option('--json', 'With --log: emit the matched entry as JSON.')
    .action(async (opts: WaitOpts) => {
      const { config, logger } = getRuntime();
      const timeoutMs = Number(opts.timeout);

      if (opts.log) {
        const entry = await waitForLog({
          config,
          pattern: new RegExp(opts.log),
          timeoutMs,
          bundle: opts.bundle,
          domain: opts.domain,
          deviceSerial: opts.device,
          logger,
        });
        if (opts.json) process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
        else logger.info(`matched: ${entry.tag}: ${entry.message}`);
        return;
      }
      if (opts.boot) {
        await waitForBoot({ config, untilPidOf: opts.pidOf, timeoutMs, deviceSerial: opts.device, logger });
        logger.info('Device booted.');
        return;
      }
      if (opts.bundle) {
        await waitForBundle({ config, bundle: opts.bundle, timeoutMs, deviceSerial: opts.device, logger });
        logger.info(`Bundle ${opts.bundle} is running.`);
        return;
      }
      throw new Error('Specify one of --log <pattern>, --boot, or --bundle <bundle>.');
    });
}
