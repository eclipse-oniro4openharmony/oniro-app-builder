import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { shell, ensureOk } from './exec.js';

export interface ParamOptions {
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/** Read a system property via `hdc shell param get <key>`. Returns the trimmed value. */
export async function paramGet(config: ConfigProvider, key: string, opts: ParamOptions = {}): Promise<string> {
  const res = await shell({
    config,
    command: `param get ${key}`,
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 10_000,
    logger: opts.logger,
  });
  ensureOk(res, `hdc shell param get ${key}`);
  return res.stdout.trim();
}

/**
 * Set a system property via `hdc shell param set <key> <value>`. The canonical
 * reboot path is `paramSet(config, 'ohos.startup.powerctrl', 'reboot')`.
 */
export async function paramSet(
  config: ConfigProvider,
  key: string,
  value: string,
  opts: ParamOptions = {},
): Promise<void> {
  const res = await shell({
    config,
    command: `param set ${key} ${value}`,
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 10_000,
    logger: opts.logger,
  });
  ensureOk(res, `hdc shell param set ${key} ${value}`);
}
