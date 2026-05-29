import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { shell } from './exec.js';
import { paramSet } from './param.js';
import { findRunningProcess } from './app.js';
import { waitForCondition } from './wait.js';

/** Probe whether the device responds to a trivial shell command. */
async function isReachable(config: ConfigProvider, deviceSerial?: string): Promise<boolean> {
  try {
    const res = await shell({ config, command: 'echo oniro_ping', deviceSerial, timeoutMs: 5_000 });
    return res.code === 0 && res.stdout.includes('oniro_ping');
  } catch {
    return false;
  }
}

export interface WaitForBundleOptions {
  config: ConfigProvider;
  bundle: string;
  deviceSerial?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/**
 * Poll `pidof <bundle>` until the bundle has a clean numeric pid. Empty/failed
 * pidof responses (including while the device is unreachable) do NOT count.
 */
export async function waitForBundle(opts: WaitForBundleOptions): Promise<void> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  const timeoutMs = opts.timeoutMs ?? 180_000;
  await waitForCondition({
    probe: async () =>
      (await findRunningProcess({ config: opts.config, bundle: opts.bundle, deviceSerial: opts.deviceSerial, timeoutMs: 8_000 })) !== null,
    timeoutMs,
    pollMs: 2_000,
    abortSignal: opts.abortSignal,
    onHeartbeat: (attempt, remaining) =>
      logger.info(`waiting for ${opts.bundle} (attempt ${attempt}, ${Math.floor(remaining / 1000)}s left)`),
    timeoutMessage: `Bundle ${opts.bundle} did not start within ${timeoutMs}ms.`,
  });
}

export interface WaitForBootOptions {
  config: ConfigProvider;
  /** Require a clean numeric pid for this process/bundle name before returning. */
  untilPidOf?: string;
  deviceSerial?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/**
 * Poll until the device responds AND (when `untilPidOf` is set) that process has
 * a clean numeric pid. Tolerates the transient hdc disconnect during a reboot.
 */
export async function waitForBoot(opts: WaitForBootOptions): Promise<void> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  const timeoutMs = opts.timeoutMs ?? 180_000;
  await waitForCondition({
    probe: async () => {
      if (!(await isReachable(opts.config, opts.deviceSerial))) return false;
      if (!opts.untilPidOf) return true;
      return (
        (await findRunningProcess({ config: opts.config, bundle: opts.untilPidOf, deviceSerial: opts.deviceSerial, timeoutMs: 8_000 })) !== null
      );
    },
    timeoutMs,
    pollMs: 2_000,
    abortSignal: opts.abortSignal,
    onHeartbeat: (attempt, remaining) =>
      logger.info(`waiting for boot (attempt ${attempt}, ${Math.floor(remaining / 1000)}s left)`),
    timeoutMessage: `Device did not boot within ${timeoutMs}ms.`,
  });
}

export interface RebootOptions {
  config: ConfigProvider;
  /** 'system' (default) reboots via param set; bootloader/recovery via `reboot <mode>`. */
  mode?: 'system' | 'bootloader' | 'recovery';
  /** When set (system mode), block until this bundle has a clean numeric pid after the reboot. */
  waitForBundle?: string;
  deviceSerial?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/**
 * Reboot the device. System reboots use `param set ohos.startup.powerctrl reboot`
 * (the path that works when force-stopping systemui is blocked); bootloader/
 * recovery use `hdc shell reboot <mode>`. A reboot frequently tears down the hdc
 * connection before the command returns, so command failure here is tolerated.
 *
 * When `waitForBundle` is set (system mode), waits for the device to drop and
 * come back with the bundle running — so it doesn't return on the pre-reboot pid.
 */
export async function reboot(opts: RebootOptions): Promise<void> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'hdc');
  const mode = opts.mode ?? 'system';
  const timeoutMs = opts.timeoutMs ?? 180_000;

  logger.info(`Rebooting device (${mode})...`);
  try {
    if (mode === 'system') {
      await paramSet(opts.config, 'ohos.startup.powerctrl', 'reboot', {
        deviceSerial: opts.deviceSerial,
        timeoutMs: 15_000,
        logger: opts.logger,
      });
    } else {
      await shell({ config: opts.config, command: `reboot ${mode}`, deviceSerial: opts.deviceSerial, timeoutMs: 15_000 });
    }
  } catch (err) {
    // Expected: the reboot tore down hdc before the command returned cleanly.
    logger.debug(`reboot command did not return cleanly: ${(err as Error).message}`);
  }

  if (mode !== 'system' || !opts.waitForBundle) return;

  // Wait for the device to actually go down first (best-effort) so the subsequent
  // bundle wait can't match the pre-reboot process, then wait for it to return.
  try {
    await waitForCondition({
      probe: async () => !(await isReachable(opts.config, opts.deviceSerial)),
      timeoutMs: Math.min(timeoutMs, 30_000),
      pollMs: 1_500,
      abortSignal: opts.abortSignal,
      timeoutMessage: 'device did not become unreachable',
    });
  } catch {
    // Device may reboot too fast to observe the down state — proceed to wait for it.
  }

  await waitForBundle({
    config: opts.config,
    bundle: opts.waitForBundle,
    deviceSerial: opts.deviceSerial,
    timeoutMs,
    abortSignal: opts.abortSignal,
    logger: opts.logger,
  });
}
