import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { paramGet } from '../hdc/param.js';
import { dumpScreen } from './hidumper.js';

export interface DeviceFullInfo {
  serial: string;
  model?: string;
  manufacturer?: string;
  brand?: string;
  osFullName?: string;
  osReleaseType?: string;
  sdkApiVersion?: string;
  buildVersion?: string;
  display: { width: number; height: number } | null;
}

// Mirrors the MCP get_device_info property set.
const PROPS: ReadonlyArray<[keyof DeviceFullInfo, string]> = [
  ['model', 'const.product.model'],
  ['manufacturer', 'const.product.manufacturer'],
  ['brand', 'const.product.brand'],
  ['osFullName', 'const.ohos.fullname'],
  ['osReleaseType', 'const.ohos.releasetype'],
  ['sdkApiVersion', 'const.ohos.apiversion'],
  ['buildVersion', 'const.product.software.version'],
];

export interface GetDeviceInfoOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/** Collate device properties (`param get` × N) and the display resolution. */
export async function getDeviceInfo(opts: GetDeviceInfoOptions): Promise<DeviceFullInfo> {
  const info: DeviceFullInfo = { serial: opts.deviceSerial ?? '(default)', display: null };

  for (const [field, prop] of PROPS) {
    try {
      const value = await paramGet(opts.config, prop, { deviceSerial: opts.deviceSerial, timeoutMs: opts.timeoutMs ?? 10_000, logger: opts.logger });
      if (value) (info[field] as string) = value;
    } catch {
      // A missing/failed property is left undefined rather than failing the whole collation.
    }
  }

  const screen = await dumpScreen({ config: opts.config, deviceSerial: opts.deviceSerial, logger: opts.logger });
  if (screen) info.display = { width: screen.width, height: screen.height };
  return info;
}
