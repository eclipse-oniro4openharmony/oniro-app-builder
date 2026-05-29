import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { takeScreenshot, captureBurst } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface ScreenshotOpts {
  output: string;
  burst?: string;
  interval: string;
  device?: string;
}

export function registerScreenshotCommand(program: Command): void {
  program
    .command('screenshot')
    .description('Capture the screen as a raw JPEG to a file (no grid overlay — that lives in the MCP).')
    .option('-o, --output <file>', 'Output file path.', 'screenshot.jpeg')
    .option('--burst <count>', 'Capture N frames; writes <base>-<i><ext>.')
    .option('--interval <ms>', 'Delay between burst frames, ms.', '50')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: ScreenshotOpts) => {
      const { config, logger } = getRuntime();
      if (opts.burst) {
        const frames = await captureBurst({
          config,
          count: Number(opts.burst),
          intervalMs: Number(opts.interval),
          deviceSerial: opts.device,
          logger,
        });
        const ext = path.extname(opts.output) || '.jpeg';
        const base = opts.output.slice(0, opts.output.length - ext.length);
        frames.forEach((frame, i) => fs.writeFileSync(`${base}-${i}${ext}`, frame));
        logger.info(`Wrote ${frames.length} frames to ${base}-<0..${frames.length - 1}>${ext}.`);
        return;
      }
      const shot = await takeScreenshot({ config, deviceSerial: opts.device, logger });
      fs.writeFileSync(opts.output, shot.pixels);
      logger.info(`Wrote ${opts.output} (${shot.width}x${shot.height}).`);
    });
}
