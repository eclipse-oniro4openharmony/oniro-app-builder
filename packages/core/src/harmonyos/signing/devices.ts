/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/signature/device-manager.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import type { ConfigProvider } from '../../ports/config.js';
import type { Logger } from '../../ports/logger.js';
import { hdcExec } from '../../hdc/exec.js';
import { listDevices } from '../../hdc/devices.js';
import type { AgcClient } from './agc.js';
import { AgcError, SIGNING_ERRORS } from './errors.js';

/**
 * The 64-hex UDID from `bm get -u` output, uppercased, or '' when there is none.
 * The wording around it varies by release, so any 64-hex token is accepted.
 *
 * @internal exposed for tests.
 */
export function parseUdid(stdout: string): string {
  return stdout.match(/\b[A-Fa-f0-9]{64}\b/)?.[0].toUpperCase() ?? '';
}

/**
 * The AGC device kind for a `hw_sc.build.os.deviceType` value. Anything else,
 * including an inaccessible property, is a phone.
 *
 * @internal exposed for tests.
 */
export function parseDeviceKind(stdout: string): string {
  return ['liteWearable', 'wearable', 'tv'].find((kind) => stdout.includes(kind)) ?? 'phone';
}

/** UDID and kind of every connected device; one that will not answer is skipped. */
async function collectLocalDevices(
  config: ConfigProvider,
  logger: Logger,
): Promise<Array<{ serial: string; udid: string; kind: string }>> {
  const devices = [];
  for (const target of await listDevices(config, { logger, timeoutMs: 15_000 })) {
    if (target.status !== 'Connected') continue;
    const shell = async (...args: string[]) =>
      (await hdcExec({ config, deviceSerial: target.serial, args: ['shell', ...args], timeoutMs: 15_000, logger }))
        .stdout;
    try {
      const udid = parseUdid(await shell('bm', 'get', '-u'));
      if (!udid) {
        logger.warn(`[harmonyos] ${target.serial} did not report a UDID; skipping it.`);
        continue;
      }
      devices.push({ serial: target.serial, udid, kind: parseDeviceKind(await shell('getprop', 'hw_sc.build.os.deviceType')) });
    } catch (err) {
      logger.warn(`[harmonyos] Could not read ${target.serial}: ${(err as Error).message}`);
    }
  }
  return devices;
}

/**
 * Register every connected device with the team, and return the team's device ids
 * and the connected UDIDs.
 *
 * The profile names every registered device, not only the connected ones, so it
 * stays valid across devices — and no device needs to be connected at all once the
 * team has some registered (from another machine, or by DevEco Studio).
 */
export async function registerDevices(
  agc: AgcClient,
  config: ConfigProvider,
  logger: Logger,
): Promise<{ deviceIds: string[]; connectedUdids: string[] }> {
  const connected = await collectLocalDevices(config, logger);
  let devices = await agc.listDevices();
  const registered = new Set(devices.map((d) => d.udid.toUpperCase()));

  const unregistered = connected.filter((d) => !registered.has(d.udid));
  for (const device of unregistered) {
    logger.info(`[harmonyos] Registering ${device.serial} with AppGallery Connect...`);
    await agc.addDevice(device.udid, device.kind);
  }
  if (unregistered.length > 0) devices = await agc.listDevices();

  const deviceIds = devices.map((d) => d.id);
  if (deviceIds.length === 0) throw new AgcError(SIGNING_ERRORS.DEVICE_NONE);
  if (connected.length === 0) {
    logger.warn(
      `[harmonyos] No device is connected; the profile will name the ${deviceIds.length} device(s) already registered to this team.`,
    );
  }
  return { deviceIds, connectedUdids: connected.map((d) => d.udid) };
}
