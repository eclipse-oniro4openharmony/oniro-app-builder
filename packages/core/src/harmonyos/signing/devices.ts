/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/signature/device-manager.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import type { ConfigProvider } from '../../ports/config.js';
import type { Logger } from '../../ports/logger.js';
import { hdcExec } from '../../hdc/exec.js';
import { isUsableDevice, listDevices } from '../../hdc/devices.js';
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

export interface LocalDevice {
  serial: string;
  /** Uppercased. */
  udid: string;
  kind: string;
}

export interface LocalDevices {
  /** The attached devices that reported a UDID. */
  devices: LocalDevice[];
  /** Serials of the attached devices that could not be used; each was warned about. */
  skipped: string[];
}

/**
 * UDID and kind of every attached device. One that is not usable, reports no UDID,
 * or will not answer is skipped with a warning that says why.
 */
export async function collectLocalDevices(config: ConfigProvider, logger: Logger): Promise<LocalDevices> {
  const devices: LocalDevice[] = [];
  const skipped: string[] = [];
  for (const target of await listDevices(config, { logger, timeoutMs: 15_000 })) {
    const skip = (why: string) => {
      logger.warn(`[harmonyos] ${target.serial} ${why}`);
      skipped.push(target.serial);
    };
    if (!isUsableDevice(target)) {
      skip(
        target.status === 'Unauthorized'
          ? 'is unauthorized; accept the debugging prompt on the device to register it.'
          : `is ${target.status.toLowerCase()}; skipping it.`,
      );
      continue;
    }
    const shell = async (...args: string[]) =>
      (await hdcExec({ config, deviceSerial: target.serial, args: ['shell', ...args], timeoutMs: 15_000, logger }))
        .stdout;
    try {
      const udid = parseUdid(await shell('bm', 'get', '-u'));
      if (!udid) {
        skip('did not report a UDID (`bm get -u`), so it cannot be registered.');
        continue;
      }
      devices.push({ serial: target.serial, udid, kind: parseDeviceKind(await shell('getprop', 'hw_sc.build.os.deviceType')) });
    } catch (err) {
      skip(`could not be read: ${(err as Error).message}`);
    }
  }
  return { devices, skipped };
}

/**
 * Register the connected devices the team does not know yet, and return the ids of
 * every device registered to the team.
 *
 * The profile names every registered device, not only the connected ones, so it
 * stays valid across devices — and no device needs to be connected at all once the
 * team has some registered (from another machine, or by DevEco Studio).
 */
export async function registerDevices(agc: AgcClient, connected: LocalDevice[], logger: Logger): Promise<string[]> {
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
  return deviceIds;
}
