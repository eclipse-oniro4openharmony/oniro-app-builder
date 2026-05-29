import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { shell, ensureOk } from './exec.js';
import { recvFile } from './files.js';
import { getDisplaySize } from './display.js';

export interface Screenshot {
  /** Raw JPEG bytes, exactly as `snapshot_display` wrote them (no decode/resize). */
  pixels: Buffer;
  /** Device render width/height from hidumper; 0 when it couldn't be resolved. */
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

function tmpName(ext: string): string {
  return path.join(os.tmpdir(), `oniro_screen_${randomBytes(6).toString('hex')}.${ext}`);
}

/**
 * Capture the screen via on-device `snapshot_display`, pull the JPEG bytes back,
 * and return them raw alongside the device resolution. The agent-facing grid
 * overlay / downscale / base64 encoding stays in the MCP — core does no image
 * decoding and adds no image dependency.
 */
export async function takeScreenshot(opts: ScreenshotOptions): Promise<Screenshot> {
  const remote = '/data/local/tmp/oniro_screenshot.jpeg';
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const cap = await shell({ config: opts.config, command: `snapshot_display -f ${remote}`, deviceSerial: opts.deviceSerial, timeoutMs });
  ensureOk(cap, `snapshot_display -f ${remote}`);

  const local = tmpName('jpeg');
  try {
    await recvFile({ config: opts.config, remote, local, deviceSerial: opts.deviceSerial, timeoutMs });
    const pixels = await fs.promises.readFile(local);
    const size = (await getDisplaySize(opts.config, { deviceSerial: opts.deviceSerial })) ?? { width: 0, height: 0 };
    return { pixels, width: size.width, height: size.height };
  } finally {
    fs.promises.unlink(local).catch(() => {});
    void shell({ config: opts.config, command: `rm -f ${remote}`, deviceSerial: opts.deviceSerial }).catch(() => {});
  }
}

export interface CaptureBurstOptions {
  config: ConfigProvider;
  count: number;
  /** Delay between device-side captures, ms. */
  intervalMs: number;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Capture `count` frames `intervalMs` apart in a single device-side loop, then
 * pull each frame back. Returns the raw JPEG buffers in order. The MCP composites
 * these into a contact sheet + per-frame diff; core just returns the frames.
 */
export async function captureBurst(opts: CaptureBurstOptions): Promise<Buffer[]> {
  const count = Math.max(1, Math.floor(opts.count));
  const remoteDir = `/data/local/tmp/oniro_burst_${randomBytes(6).toString('hex')}`;
  const sleepSec = opts.intervalMs > 0 ? (opts.intervalMs / 1000).toFixed(3) : '0';
  // One device-side loop so the frames are device-timed, not gated on host roundtrips.
  const loop =
    `mkdir -p ${remoteDir}; i=0; while [ $i -lt ${count} ]; do ` +
    `snapshot_display -f ${remoteDir}/f$i.jpeg; ` +
    `[ ${count} -gt 1 ] && sleep ${sleepSec}; i=$((i+1)); done`;
  const cap = await shell({ config: opts.config, command: loop, deviceSerial: opts.deviceSerial, timeoutMs: opts.timeoutMs ?? 120_000 });
  ensureOk(cap, 'snapshot_display burst');

  const frames: Buffer[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const local = tmpName(`burst_${i}.jpeg`);
      try {
        await recvFile({ config: opts.config, remote: `${remoteDir}/f${i}.jpeg`, local, deviceSerial: opts.deviceSerial });
        frames.push(await fs.promises.readFile(local));
      } finally {
        fs.promises.unlink(local).catch(() => {});
      }
    }
  } finally {
    void shell({ config: opts.config, command: `rm -rf ${remoteDir}`, deviceSerial: opts.deviceSerial }).catch(() => {});
  }
  return frames;
}
