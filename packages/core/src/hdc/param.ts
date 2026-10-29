import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { shell, ensureOk } from './exec.js';

export interface ParamOptions {
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * `param get` prints this instead of a value for an unset property (and still
 * exits 0), e.g. `Get parameter "const.product.os.dist.name" fail! errNum is:106!`
 * on OpenHarmony.
 */
const PARAM_MISSING_RE = /^Get parameter ".*" fail!/;

/** Read a system property via `hdc shell param get <key>`. Returns the trimmed value; throws when it is unset. */
export async function paramGet(config: ConfigProvider, key: string, opts: ParamOptions = {}): Promise<string> {
  const res = await shell({
    config,
    command: `param get ${key}`,
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 10_000,
    logger: opts.logger,
  });
  ensureOk(res, `hdc shell param get ${key}`);
  const value = res.stdout.trim();
  if (PARAM_MISSING_RE.test(value)) throw new OniroError(`System parameter ${key} is not set: ${value}`);
  return value;
}

const PARAM_SEPARATOR = '__ONIRO_PARAM__';

/**
 * Split the output of {@link paramGetMany}'s single shell call back into one value
 * per key; unset properties come back undefined. Pure/testable.
 */
export function parseParamValues(keys: readonly string[], stdout: string): Record<string, string | undefined> {
  const parts = stdout.split(PARAM_SEPARATOR);
  const values: Record<string, string | undefined> = {};
  keys.forEach((key, i) => {
    const value = parts[i]?.trim();
    values[key] = value && !PARAM_MISSING_RE.test(value) ? value : undefined;
  });
  return values;
}

/** Read several system properties in one `hdc shell` round trip. Unset properties come back undefined. */
export async function paramGetMany(
  config: ConfigProvider,
  keys: readonly string[],
  opts: ParamOptions = {},
): Promise<Record<string, string | undefined>> {
  const res = await shell({
    config,
    command: keys.map((k) => `param get ${k}; echo ${PARAM_SEPARATOR}`).join('; '),
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 10_000,
    logger: opts.logger,
  });
  ensureOk(res, 'hdc shell param get …');
  return parseParamValues(keys, res.stdout);
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
