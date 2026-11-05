import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { shell } from './exec.js';
import { dumpLayout, flattenLayout, type LayoutNode } from './dump.js';
import { getDisplaySize } from './display.js';
import { sendInput } from './input.js';

/** The power manager's state, as `hidumper -s 3301` prints it: AWAKE, DIM, INACTIVE, SLEEP, … */
export function parsePowerState(hidumperOutput: string): string | null {
  return /Current State:\s*([A-Z_]+)/.exec(hidumperOutput)?.[1] ?? null;
}

/** The SceneBoard lock screen is on top: its root component is in the layout. */
export function isLockScreenShown(tree: LayoutNode): boolean {
  return flattenLayout(tree).some((n) => n.id === 'ScreenLockRootComponent');
}

export interface WakeScreenOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  logger?: Logger;
}

export interface WakeScreenResult {
  /** The device was not AWAKE and `power-shell wakeup` was sent. */
  woke: boolean;
  /** The lock screen was swiped away. */
  unlocked: boolean;
  /** The lock screen is still shown after the swipe: it needs a PIN, password or pattern. */
  locked: boolean;
}

/**
 * Turn the screen on and swipe away a lock screen that has no credential, so UI
 * tests and input reach the app. A lock screen that asks for a credential stays
 * (`locked: true`). Best effort: a check that fails is treated as "nothing to do".
 */
export async function wakeAndUnlock(opts: WakeScreenOptions): Promise<WakeScreenResult> {
  const logger = opts.logger ?? noopLogger;
  const { config, deviceSerial } = opts;
  const result: WakeScreenResult = { woke: false, unlocked: false, locked: false };

  const state = parsePowerState(
    (await shell({ config, command: 'hidumper -s 3301 -a -a', deviceSerial, timeoutMs: 15_000 }).catch(() => null))
      ?.stdout ?? '',
  );
  if (state && state !== 'AWAKE') {
    logger.info(`screen is ${state}; waking it`);
    await shell({ config, command: 'power-shell wakeup', deviceSerial, timeoutMs: 15_000 });
    result.woke = true;
    await new Promise((r) => setTimeout(r, 500));
  }

  const lockShown = async (): Promise<boolean> => {
    try {
      return isLockScreenShown((await dumpLayout({ config, deviceSerial, timeoutMs: 20_000 })).tree);
    } catch (err) {
      logger.debug(`lock screen check skipped: ${(err as Error).message}`);
      return false;
    }
  };
  if (!(await lockShown())) return result;

  const display = await getDisplaySize(config, { deviceSerial });
  const w = display?.width ?? 1080;
  const h = display?.height ?? 2400;
  logger.info('swiping the lock screen away');
  await sendInput({
    config,
    type: 'swipe',
    pxX: Math.round(w / 2),
    pxY: Math.round(h * 0.85),
    pxX2: Math.round(w / 2),
    pxY2: Math.round(h * 0.3),
    speed: 3000,
    deviceSerial,
    logger,
  });
  await new Promise((r) => setTimeout(r, 800));
  if (await lockShown()) result.locked = true;
  else result.unlocked = true;
  return result;
}

/**
 * Keep the screen on for `ms` (`power-shell timeout -o`), so a long run does not
 * let it turn off; returns a function that restores the configured timeout.
 */
export async function holdScreenOn(opts: WakeScreenOptions & { ms: number }): Promise<() => Promise<void>> {
  const { config, deviceSerial } = opts;
  const res = await shell({
    config,
    command: `power-shell timeout -o ${Math.floor(opts.ms)}`,
    deviceSerial,
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!res || res.code !== 0) return async () => undefined;
  return async () => {
    await shell({ config, command: 'power-shell timeout -r', deviceSerial, timeoutMs: 15_000 }).catch(() => undefined);
  };
}
