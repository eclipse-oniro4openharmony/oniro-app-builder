import { Command } from 'commander';
import { getDeviceInfo, listDevices, type DeviceFullInfo, type DeviceInfo } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

/** One `devices --long` line: the target-list columns, then what the device reports about itself. */
export function formatLongDevice(d: DeviceInfo, info: DeviceFullInfo | undefined): string {
  const head = `${d.serial}\t${d.connection ?? ''}\t${d.status}`;
  if (!info) return head;
  const os = [info.osFamily, info.osFamily === 'HarmonyOS' ? info.osDistVersion : undefined].filter(Boolean).join(' ');
  const fields: Array<[string, string | undefined]> = [
    ['os', os || undefined],
    ['api', info.sdkApiVersion],
    ['abi', info.abi],
    ['type', info.deviceType],
    ['model', info.model],
    ['fullname', info.osFullName],
  ];
  const rest = fields.filter(([, v]) => v).map(([k, v]) => `${k}=${/\s/.test(v!) ? JSON.stringify(v) : v}`);
  return [head, ...rest].join('\t');
}

export function registerDevicesCommand(program: Command): void {
  program
    .command('devices')
    .description('List connected hdc devices.')
    .option(
      '--long',
      'Also ask each connected device for its OS family (HarmonyOS / OpenHarmony), version, API level, ' +
        'CPU ABI, device type and model.',
    )
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (opts: { long?: boolean; json?: boolean }) => {
      const { config, logger } = getRuntime();
      const devices = await listDevices(config);
      const infos = new Map<string, DeviceFullInfo>();
      if (opts.long) {
        for (const d of devices.filter((x) => x.status === 'Connected')) {
          try {
            infos.set(d.serial, await getDeviceInfo({ config, deviceSerial: d.serial, logger }));
          } catch (err) {
            logger.warn(`Could not query ${d.serial}: ${(err as Error).message}`);
          }
        }
      }
      if (opts.json) {
        const out = opts.long ? devices.map((d) => ({ ...d, info: infos.get(d.serial) ?? null })) : devices;
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        return;
      }
      if (devices.length === 0) {
        process.stdout.write('(no devices)\n');
        return;
      }
      for (const d of devices) {
        process.stdout.write(`${opts.long ? formatLongDevice(d, infos.get(d.serial)) : `${d.serial}\t${d.connection ?? ''}\t${d.status}`}\n`);
      }
    });
}
