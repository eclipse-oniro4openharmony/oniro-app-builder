/*
 * Launch smoke verdict: is the app's process up, does it stay up, and does it
 * draw something. The shape of the check (wait for the pid, settle, capture,
 * judge the frame against a flat one) follows deveco-cli's smoke inspector
 * (openharmony-sig/deveco-cli, packages/cli/src/smoke/, Copyright (c) 2026
 * Huawei Device Co., Ltd., MIT License); the code is written for this
 * library. See NOTICE.
 */
import * as fs from 'node:fs';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { analyzeBlank, type BlankAnalysis, type GreyImage } from '../image/hash.js';
import { findRunningProcess } from './app.js';
import { takeScreenshot } from './screen.js';

/** Default wait between the process appearing and the screenshot. */
export const DEFAULT_SMOKE_DELAY_MS = 2000;
/** Default deadline for the process to appear after launch. */
export const DEFAULT_SMOKE_PID_TIMEOUT_MS = 10_000;
const PID_POLL_MS = 500;

/** Decodes a JPEG screenshot to greyscale. Core decodes no images; the CLI passes a sharp-based one. */
export type GreyscaleDecoder = (jpeg: Buffer) => Promise<GreyImage>;

/** What a {@link SmokeCrashProbe} is asked: was there a crash of `bundle` since `since`? */
export interface SmokeCrashProbeArgs {
  config: ConfigProvider;
  bundle: string;
  /** When the launch started; only crashes at or after it count. */
  since: Date;
  /**
   * Whether the launched process is still the one that started. A probe can
   * wait for a faultlog when it is not (hiview writes it seconds after the
   * death) and look only once when it is.
   */
  alive: boolean;
  deviceSerial?: string;
  logger?: Logger;
}

/**
 * Crash-detection hook. Resolve a description of the newest crash (cpp_crash,
 * js_crash, app_freeze, …) of the bundle since the launch, or null when there
 * was none. The CLI passes the faultlog reader (`latestCrash`). A probe that
 * throws is logged and counts as no crash.
 */
export type SmokeCrashProbe<C = unknown> = (args: SmokeCrashProbeArgs) => Promise<C | null>;

export interface SmokeCheckOptions<C = unknown> {
  config: ConfigProvider;
  bundle: string;
  /** When the launch was issued (crash window start). Default: when the check starts. */
  since?: Date;
  /** Wait between the process appearing and the screenshot. Default {@link DEFAULT_SMOKE_DELAY_MS}. */
  delayMs?: number;
  /** Deadline for the process to appear. Default {@link DEFAULT_SMOKE_PID_TIMEOUT_MS}. */
  pidTimeoutMs?: number;
  /** Where to write the screenshot JPEG. When omitted it is analysed but not kept. */
  screenshotPath?: string;
  /** Turns the JPEG into greyscale for the blank check; without it `blankScreen` is null. */
  decodeGreyscale?: GreyscaleDecoder;
  /** Crash-detection hook; see {@link SmokeCrashProbe}. Without it `crash` is null. */
  crashProbe?: SmokeCrashProbe<C>;
  deviceSerial?: string;
  logger?: Logger;
}

export interface SmokeResult<C = unknown> {
  /** All checks passed: the process came up and stayed up, the screen is not blank, no crash. */
  passed: boolean;
  /** Why it failed, one line per failed check; empty when it passed. */
  failures: string[];
  /** Pid seen after launch, or null when the process never appeared. */
  pid: number | null;
  /** The process seen after launch was still running (same pid) after the delay. */
  alive: boolean;
  /** Pid after the delay when it differs from `pid` (the app died and was restarted), else absent. */
  pidAfter?: number | null;
  /** The app area is a flat frame; null when no decoder was given or the screenshot failed. */
  blankScreen: boolean | null;
  /** Share (0-1) of the app area in its dominant colour; 1 = flat. Null with `blankScreen`. */
  blankScore: number | null;
  /** The blank-check measurements (pHash distance from a flat frame, standard deviation, background). */
  blank?: BlankAnalysis;
  /** Path of the saved screenshot, or null when none was kept. */
  screenshot: string | null;
  /** The crash probe's finding, or null (no crash, or no probe). */
  crash: C | null;
  /** Whether a crash probe ran; `crash: null` without one means "not checked". */
  crashChecked: boolean;
  delayMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pidOf(opts: SmokeCheckOptions<unknown>): Promise<number | null> {
  const proc = await findRunningProcess({ config: opts.config, bundle: opts.bundle, deviceSerial: opts.deviceSerial });
  return proc ? Number(proc.pid) : null;
}

/** Combine the observations into a verdict. Pure. */
export function smokeVerdict(o: {
  pid: number | null;
  alive: boolean;
  blankScreen: boolean | null;
  crash: unknown;
}): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (o.pid === null) failures.push('the app process did not start');
  else if (!o.alive) failures.push('the app process died after launch');
  if (o.blankScreen === true) failures.push('the screen is blank');
  if (o.crash !== null && o.crash !== undefined) failures.push('a crash was recorded since launch');
  return { passed: failures.length === 0, failures };
}

/**
 * Smoke-check a just-launched app: wait for its process, let it settle for
 * `delayMs`, capture a screenshot and judge it against a flat frame, check the
 * process is still the same one, and ask the crash probe (when given) for a
 * crash since launch. Never throws for a failed check — the verdict is in the
 * result; it throws only when the device cannot be reached.
 */
export async function smokeCheck<C = unknown>(opts: SmokeCheckOptions<C>): Promise<SmokeResult<C>> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'smoke');
  const since = opts.since ?? new Date();
  const delayMs = Math.max(0, opts.delayMs ?? DEFAULT_SMOKE_DELAY_MS);
  const deadline = Date.now() + (opts.pidTimeoutMs ?? DEFAULT_SMOKE_PID_TIMEOUT_MS);

  let pid = await pidOf(opts);
  while (pid === null && Date.now() < deadline) {
    await sleep(PID_POLL_MS);
    pid = await pidOf(opts);
  }
  if (pid === null) logger.warn(`${opts.bundle} has no running process.`);
  else logger.info(`${opts.bundle} is running as pid ${pid}; waiting ${delayMs} ms.`);
  await sleep(delayMs);

  let screenshot: string | null = null;
  let blank: BlankAnalysis | undefined;
  try {
    const shot = await takeScreenshot({ config: opts.config, deviceSerial: opts.deviceSerial, logger: opts.logger });
    if (opts.screenshotPath) {
      await fs.promises.writeFile(opts.screenshotPath, shot.pixels);
      screenshot = opts.screenshotPath;
    }
    if (opts.decodeGreyscale) blank = analyzeBlank(await opts.decodeGreyscale(shot.pixels));
  } catch (err) {
    logger.warn(`screenshot check skipped: ${(err as Error).message}`);
  }

  const now = pid === null ? null : await pidOf(opts);
  const alive = pid !== null && now === pid;

  // Crash hook: the CLI passes the faultlog reader (latestCrash).
  let crash: C | null = null;
  if (opts.crashProbe) {
    try {
      crash = await opts.crashProbe({
        config: opts.config,
        bundle: opts.bundle,
        since,
        alive,
        deviceSerial: opts.deviceSerial,
        logger: opts.logger,
      });
    } catch (err) {
      logger.warn(`crash probe failed: ${(err as Error).message}`);
    }
  }

  const blankScreen = blank ? blank.blank : null;
  const verdict = smokeVerdict({ pid, alive, blankScreen, crash });
  return {
    ...verdict,
    pid,
    alive,
    ...(pid !== null && now !== pid ? { pidAfter: now } : {}),
    blankScreen,
    blankScore: blank ? blank.blankScore : null,
    ...(blank ? { blank } : {}),
    screenshot,
    crash,
    crashChecked: !!opts.crashProbe,
    delayMs,
  };
}
