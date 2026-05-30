import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { takeScreenshot, captureBurst } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { renderWithGrid, buildContactSheet, frameDiffs } from '../lib/screenshotImage.js';

interface ScreenshotOpts {
  output: string;
  grid?: boolean;
  maxDim: string;
  contactSheet?: boolean;
  burst?: string;
  interval: string;
  json?: boolean;
  device?: string;
}

const DEFAULT_CONTACT_SHEET_FRAMES = 8;

function clampMaxDim(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1024;
  return Math.max(256, Math.min(4096, Math.round(n)));
}

export function registerScreenshotCommand(program: Command): void {
  program
    .command('screenshot')
    .description(
      'Capture the screen. Default: full-resolution raw JPEG. ' +
        '--grid: downscaled JPEG with a 10x10 grid (axes 0.0-1.0) for picking tap coordinates. ' +
        '--contact-sheet: capture a burst and tile it into one image with per-frame change diffs.',
    )
    .option('-o, --output <file>', 'Output file path.', 'screenshot.jpeg')
    .option('--grid', 'Downscale (to --max-dim) and overlay a 10x10 coordinate grid.')
    .option('--max-dim <px>', 'Longest-side cap for --grid / --contact-sheet (256-4096).', '1024')
    .option('--contact-sheet', 'Capture a burst and composite it into one tiled contact sheet.')
    .option('--burst <count>', 'Capture N frames; writes <base>-<i><ext> (or feeds --contact-sheet).')
    .option('--interval <ms>', 'Delay between burst frames, ms.', '50')
    .option('--json', 'Emit the full result object as JSON on stdout (with --contact-sheet).')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: ScreenshotOpts, command: Command) => {
      const { config, logger } = getRuntime();
      const maxDim = clampMaxDim(opts.maxDim);
      const intervalMs = Number(opts.interval) || 50;

      // --- Contact sheet: burst -> one tiled image + per-frame diffs ---
      if (opts.contactSheet) {
        const count = opts.burst ? Math.max(1, Number(opts.burst)) : DEFAULT_CONTACT_SHEET_FRAMES;
        const frames = await captureBurst({ config, count, intervalMs, deviceSerial: opts.device, logger });
        const diffs = await frameDiffs(frames);
        const sheet = await buildContactSheet(frames, { maxDim, diffs });
        fs.writeFileSync(opts.output, sheet.buf);

        // Only fan out the individual raw frames when --burst was also requested.
        if (opts.burst) {
          const ext = path.extname(opts.output) || '.jpeg';
          const base = opts.output.slice(0, opts.output.length - ext.length);
          frames.forEach((frame, i) => fs.writeFileSync(`${base}-${i}${ext}`, frame));
        }

        const perFrame = frames.map((_, i) => ({ idx: i, t_ms: i * intervalMs, diffVsPrev: diffs[i] ?? 0 }));
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                sheet: opts.output,
                frameCount: frames.length,
                cols: sheet.cols,
                rows: sheet.rows,
                intervalMs,
                note: 't_ms is nominal (idx*interval); diffVsPrev is 0..1 mean greyscale diff vs the previous frame.',
                frames: perFrame,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          process.stdout.write(`${JSON.stringify(perFrame)}\n`);
        }

        let peak = 0;
        for (let i = 1; i < diffs.length; i++) if ((diffs[i] ?? 0) > (diffs[peak] ?? 0)) peak = i;
        logger.info(
          `Wrote contact sheet ${opts.output} (${sheet.cols}x${sheet.rows}, ${frames.length} frames). ` +
            `Biggest change at frame ${peak} (Δ${(diffs[peak] ?? 0).toFixed(2)}).`,
        );
        return;
      }

      // --- Burst (raw frames) — unchanged behaviour ---
      if (opts.burst) {
        const frames = await captureBurst({
          config,
          count: Number(opts.burst),
          intervalMs,
          deviceSerial: opts.device,
          logger,
        });
        const ext = path.extname(opts.output) || '.jpeg';
        const base = opts.output.slice(0, opts.output.length - ext.length);
        frames.forEach((frame, i) => fs.writeFileSync(`${base}-${i}${ext}`, frame));
        logger.info(`Wrote ${frames.length} frames to ${base}-<0..${frames.length - 1}>${ext}.`);
        return;
      }

      // --- Single shot ---
      const shot = await takeScreenshot({ config, deviceSerial: opts.device, logger });
      const maxDimProvided = command.getOptionValueSource('maxDim') === 'cli';
      if (opts.grid || maxDimProvided) {
        const rendered = await renderWithGrid(shot.pixels, { maxDim, grid: !!opts.grid });
        fs.writeFileSync(opts.output, rendered.buf);
        logger.info(
          `Wrote ${opts.output} (${rendered.width}x${rendered.height} from ` +
            `${rendered.originalWidth}x${rendered.originalHeight}${opts.grid ? ', 10x10 grid' : ''}).`,
        );
        return;
      }
      fs.writeFileSync(opts.output, shot.pixels);
      logger.info(`Wrote ${opts.output} (${shot.width}x${shot.height}).`);
    });
}
