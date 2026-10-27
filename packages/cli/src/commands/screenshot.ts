import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { takeScreenshot, captureBurst, locateTarget, describeLayoutNode } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import {
  renderWithGrid,
  buildContactSheet,
  frameDiffs,
  cropImage,
  parseCropRect,
  padCropRect,
  type CropRect,
} from '../lib/screenshotImage.js';
import { addTargetOptions, selectorFrom, targetIndexFrom, type TargetOpts } from '../lib/target.js';

interface ScreenshotOpts extends TargetOpts {
  output: string;
  grid?: boolean;
  maxDim: string;
  crop?: string;
  contactSheet?: boolean;
  burst?: string;
  interval: string;
  json?: boolean;
  device?: string;
}

const DEFAULT_CONTACT_SHEET_FRAMES = 8;
// Margin kept around a --target element when cropping to it, as a fraction of the display.
const TARGET_CROP_PAD = 0.02;

function clampMaxDim(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1024;
  return Math.max(256, Math.min(4096, Math.round(n)));
}

export function registerScreenshotCommand(program: Command): void {
  const screenshot = program
    .command('screenshot')
    .description(
      'Capture the screen. Default: full-resolution raw JPEG. ' +
        '--grid: downscaled JPEG with a 10x10 grid (axes 0.0-1.0) for picking tap coordinates. ' +
        '--crop / --target: a full-resolution crop of one region or element, for checking detail cheaply. ' +
        '--contact-sheet: capture a burst and tile it into one image with per-frame change diffs.',
    )
    .option('-o, --output <file>', 'Output file path.', 'screenshot.jpeg')
    .option('--grid', 'Downscale (to --max-dim) and overlay a 10x10 coordinate grid.')
    .option('--max-dim <px>', 'Longest-side cap for --grid / --crop / --target / --contact-sheet (256-4096).', '1024')
    .option('--crop <x1,y1,x2,y2>', 'Crop to this region, given as 0-1 fractions of the screen.');
  addTargetOptions(screenshot, 'Crop to');
  screenshot
    .option('--contact-sheet', 'Capture a burst and composite it into one tiled contact sheet.')
    .option('--burst <count>', 'Capture N frames; writes <base>-<i><ext> (or feeds --contact-sheet).')
    .option('--interval <ms>', 'Delay between burst frames, ms.', '50')
    .option('--json', 'Emit the full result object as JSON on stdout (with --contact-sheet).')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: ScreenshotOpts, command: Command) => {
      const { config, logger } = getRuntime();
      const maxDim = clampMaxDim(opts.maxDim);
      const intervalMs = Number(opts.interval) || 50;

      // --- Crop: one region (or element) at full resolution ---
      const selector = selectorFrom(opts);
      if (opts.crop !== undefined || selector) {
        if (opts.crop !== undefined && selector) throw new Error('Use either --crop or --target*, not both.');
        if (opts.grid || opts.contactSheet || opts.burst) {
          throw new Error('--crop / --target cannot be combined with --grid, --contact-sheet, or --burst.');
        }
        let rect: CropRect;
        let label: string;
        if (selector) {
          // Leave the keyboard alone: dismissing it would change what we are capturing.
          const located = await locateTarget({
            config,
            selector,
            index: targetIndexFrom(opts),
            hideKeyboard: false,
            deviceSerial: opts.device,
            logger,
          });
          if (!located.node.b) throw new Error(`${describeLayoutNode(located.node)} has no bounds to crop to.`);
          rect = padCropRect(located.node.b, TARGET_CROP_PAD);
          label = describeLayoutNode(located.node);
        } else {
          rect = parseCropRect(opts.crop!);
          label = rect.map((n) => n.toFixed(3)).join(',');
        }
        const shot = await takeScreenshot({ config, deviceSerial: opts.device, logger });
        const cropped = await cropImage(shot.pixels, rect, { maxDim });
        fs.writeFileSync(opts.output, cropped.buf);
        logger.info(
          `Wrote ${opts.output} (${cropped.width}x${cropped.height} from a ${cropped.cropWidth}x${cropped.cropHeight} ` +
            `crop at ${cropped.left},${cropped.top}: ${label}).`,
        );
        return;
      }

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
