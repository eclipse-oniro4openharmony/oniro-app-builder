import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { shell, ensureOk } from './exec.js';
import { recvFile } from './files.js';
import { getDisplaySize } from './display.js';
import { OniroError } from '../ports/errors.js';

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
 * `snapshot_display` asks RenderService for a frame and gives up when none comes
 * within 2 s: it prints "error: snapshot display …" and writes no file. A busy
 * compositor (an app starting on a software-rendered emulator) can miss that
 * window now and then, so a capture that leaves no file is retried.
 */
export const SNAPSHOT_ATTEMPTS = 3;
const SNAPSHOT_RETRY_DELAY_MS = 500;
/** Printed by the capture command only when a non-empty file was written. */
const SNAPSHOT_OK = '__ONIRO_SNAPSHOT_OK__';

/** Device-side capture of one file: remove any old copy, capture, check the result. */
export function snapshotCommand(remote: string): string {
  return `rm -f ${remote}; snapshot_display -f ${remote}; [ -s ${remote} ] && echo ${SNAPSHOT_OK}`;
}

/** snapshot_display's own complaint, for the error raised when every attempt failed. */
export function snapshotFailureDetail(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => /^error\b|fail/i.test(l));
  return (errors.length ? errors : lines.slice(-3)).join('\n') || 'snapshot_display wrote no file.';
}

/**
 * Capture the screen into `remote` on the device, retrying when no file was written.
 * Throws with snapshot_display's own message once {@link SNAPSHOT_ATTEMPTS} attempts failed.
 */
async function captureOnDevice(opts: ScreenshotOptions, remote: string, timeoutMs: number): Promise<void> {
  const command = snapshotCommand(remote);
  let detail = '';
  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
    const cap = await shell({ config: opts.config, command, deviceSerial: opts.deviceSerial, timeoutMs });
    ensureOk(cap, `snapshot_display -f ${remote}`);
    if (cap.stdout.includes(SNAPSHOT_OK)) return;
    detail = snapshotFailureDetail(cap.stdout);
    opts.logger?.debug(`screenshot attempt ${attempt}/${SNAPSHOT_ATTEMPTS} wrote no file: ${detail.replace(/\n/g, ' ')}`);
    if (attempt < SNAPSHOT_ATTEMPTS) await new Promise((r) => setTimeout(r, SNAPSHOT_RETRY_DELAY_MS));
  }
  throw new OniroError(
    `Screenshot failed: snapshot_display wrote no file in ${SNAPSHOT_ATTEMPTS} attempts.\n${detail}\n` +
      'RenderService did not deliver a frame within its 2 s limit; the compositor may be busy (an app starting).',
  );
}

/**
 * Capture the screen via on-device `snapshot_display`, pull the JPEG bytes back,
 * and return them raw alongside the device resolution. The agent-facing grid
 * overlay / downscale / base64 encoding stays in the MCP — core does no image
 * decoding and adds no image dependency.
 */
export async function takeScreenshot(opts: ScreenshotOptions): Promise<Screenshot> {
  // A name per call: the previous call's clean-up `rm` runs in the background and
  // must not delete this capture before it is pulled.
  const remote = `/data/local/tmp/oniro_screenshot_${randomBytes(6).toString('hex')}.jpeg`;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  await captureOnDevice(opts, remote, timeoutMs);

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
  // A frame that leaves no file is retried in place, like a single screenshot.
  const retryDelaySec = (SNAPSHOT_RETRY_DELAY_MS / 1000).toFixed(3);
  const loop =
    `mkdir -p ${remoteDir}; i=0; while [ $i -lt ${count} ]; do ` +
    `t=1; while :; do snapshot_display -f ${remoteDir}/f$i.jpeg; ` +
    `[ -s ${remoteDir}/f$i.jpeg ] || [ $t -ge ${SNAPSHOT_ATTEMPTS} ] && break; t=$((t+1)); sleep ${retryDelaySec}; done; ` +
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
