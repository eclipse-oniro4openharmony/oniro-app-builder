import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { shell } from './exec.js';

export interface DisplaySize {
  width: number;
  height: number;
}

export interface DisplaySizeOptions {
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * RenderService's `render resolution` is the panel's physical mode and ignores
 * rotation; the display manager's `ScreenRotation` (degrees) says whether the
 * screen is turned. One shell round trip fetches both.
 */
const DISPLAY_SIZE_COMMAND =
  "hidumper -s 10 -a screen; hidumper -s DisplayManagerService -a -a | grep -m 1 '^ScreenRotation:'";

/**
 * Parse the output of the display-size command into the size of the screen as
 * it is shown: width and height are swapped when the screen is rotated by 90 or
 * 270 degrees, so they match screenshots, layout bounds and the coordinates
 * uitest injects input at. Without a `ScreenRotation` line (a dumper that does
 * not print one) the physical size is returned. Null when there is no
 * `render resolution`.
 */
export function parseDisplaySize(text: string): DisplaySize | null {
  const m = text.match(/render resolution=(\d+)x(\d+)/);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const r = text.match(/^ScreenRotation:\s*(-?\d+(?:\.\d+)?)/m);
  const quarterTurns = r ? Math.round(Number(r[1]) / 90) : 0;
  return quarterTurns % 2 !== 0 ? { width: height, height: width } : { width, height };
}

/**
 * Resolve the size of the screen as it is shown (rotation applied): the W/H
 * source for screenshots, the 0–1 normalization of layout bounds and the
 * conversion of fractions back to input pixels — no image decoding is
 * involved. Returns null when unavailable.
 */
export async function getDisplaySize(config: ConfigProvider, opts: DisplaySizeOptions = {}): Promise<DisplaySize | null> {
  const res = await shell({
    config,
    command: DISPLAY_SIZE_COMMAND,
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 10_000,
    logger: opts.logger,
  });
  if (res.code !== 0) return null;
  return parseDisplaySize(res.stdout);
}
