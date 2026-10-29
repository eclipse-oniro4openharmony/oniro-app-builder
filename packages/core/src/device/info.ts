import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { paramGetMany } from '../hdc/param.js';
import { dumpScreen } from './hidumper.js';

export interface DeviceFullInfo {
  serial: string;
  model?: string;
  manufacturer?: string;
  brand?: string;
  /** `HarmonyOS` when the device reports a HarmonyOS distribution, else `OpenHarmony` (Oniro included). */
  osFamily?: 'HarmonyOS' | 'OpenHarmony';
  /** Distribution name (`const.product.os.dist.name`): `HarmonyOS`; unset on OpenHarmony. */
  osDistName?: string;
  /** Distribution version (`const.product.os.dist.version`), e.g. `6.1.0` on HarmonyOS. */
  osDistVersion?: string;
  osFullName?: string;
  osReleaseType?: string;
  sdkApiVersion?: string;
  buildVersion?: string;
  /** CPU ABIs (`const.product.cpu.abilist`), e.g. `arm64-v8a` or `x86_64`: native libraries must match. */
  abi?: string;
  /** `phone`, `tablet`, `wearable`, `default`, … */
  deviceType?: string;
  display: { width: number; height: number } | null;
}

type ParamField = Exclude<keyof DeviceFullInfo, 'serial' | 'display' | 'osFamily'>;

// The MCP get_device_info property set, plus what picking a target for an app needs.
const PROPS: ReadonlyArray<[ParamField, string]> = [
  ['model', 'const.product.model'],
  ['manufacturer', 'const.product.manufacturer'],
  ['brand', 'const.product.brand'],
  ['osDistName', 'const.product.os.dist.name'],
  ['osDistVersion', 'const.product.os.dist.version'],
  ['osFullName', 'const.ohos.fullname'],
  ['osReleaseType', 'const.ohos.releasetype'],
  ['sdkApiVersion', 'const.ohos.apiversion'],
  ['buildVersion', 'const.product.software.version'],
  ['abi', 'const.product.cpu.abilist'],
  ['deviceType', 'const.product.devicetype'],
];

export interface GetDeviceInfoOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/** Collate device properties (one `param get` round trip) and the display resolution. */
export async function getDeviceInfo(opts: GetDeviceInfoOptions): Promise<DeviceFullInfo> {
  const info: DeviceFullInfo = { serial: opts.deviceSerial ?? '(default)', display: null };

  try {
    const values = await paramGetMany(
      opts.config,
      PROPS.map(([, prop]) => prop),
      { deviceSerial: opts.deviceSerial, timeoutMs: opts.timeoutMs ?? 10_000, logger: opts.logger },
    );
    for (const [field, prop] of PROPS) {
      const value = values[prop];
      if (value) info[field] = value;
    }
  } catch {
    // Missing properties are left undefined rather than failing the whole collation.
  }
  if (info.osDistName || info.osFullName) {
    info.osFamily = /harmonyos/i.test(info.osDistName ?? '') ? 'HarmonyOS' : 'OpenHarmony';
  }

  const screen = await dumpScreen({ config: opts.config, deviceSerial: opts.deviceSerial, logger: opts.logger });
  if (screen) info.display = { width: screen.width, height: screen.height };
  return info;
}
