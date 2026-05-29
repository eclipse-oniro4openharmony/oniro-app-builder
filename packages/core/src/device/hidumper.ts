import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { shell } from '../hdc/exec.js';

export interface HidumperOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export interface ScreenDump {
  width: number;
  height: number;
  /** Raw hidumper screen output. */
  raw: string;
}

/** `hidumper -s 10 -a screen` → parsed render resolution + raw text, or null. */
export async function dumpScreen(opts: HidumperOptions): Promise<ScreenDump | null> {
  const res = await shell({ config: opts.config, command: 'hidumper -s 10 -a screen', deviceSerial: opts.deviceSerial, timeoutMs: opts.timeoutMs ?? 10_000, logger: opts.logger });
  if (res.code !== 0) return null;
  const m = res.stdout.match(/render resolution=(\d+)x(\d+)/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]), raw: res.stdout };
}

/** `hidumper -s WindowManagerService -a -a` — windows in z-order with surface presence. */
export async function dumpWindow(opts: HidumperOptions): Promise<string> {
  const res = await shell({ config: opts.config, command: 'hidumper -s WindowManagerService -a -a', deviceSerial: opts.deviceSerial, timeoutMs: opts.timeoutMs ?? 15_000, logger: opts.logger });
  return res.stdout;
}

/** `hidumper -s RenderService -a allInfo` — composition state / refresh rate. */
export async function dumpRenderService(opts: HidumperOptions): Promise<string> {
  const res = await shell({ config: opts.config, command: 'hidumper -s RenderService -a allInfo', deviceSerial: opts.deviceSerial, timeoutMs: opts.timeoutMs ?? 15_000, logger: opts.logger });
  return res.stdout;
}
