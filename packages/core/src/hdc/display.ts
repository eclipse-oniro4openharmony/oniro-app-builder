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
 * Resolve the device's render resolution from `hidumper -s 10 -a screen`
 * (`render resolution=WxH`). Returns null when unavailable. This is the W/H
 * source for screenshots and the 0–1 normalization of layout bounds — no image
 * decoding is involved.
 */
export async function getDisplaySize(config: ConfigProvider, opts: DisplaySizeOptions = {}): Promise<DisplaySize | null> {
  const res = await shell({
    config,
    command: 'hidumper -s 10 -a screen',
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 10_000,
    logger: opts.logger,
  });
  if (res.code !== 0) return null;
  const m = res.stdout.match(/render resolution=(\d+)x(\d+)/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}
