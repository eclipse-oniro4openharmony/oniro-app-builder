import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { hdcExec } from './exec.js';

export interface DeviceInfo {
  /** Connect key — a USB serial or a `host:port` for a TCP target. */
  serial: string;
  /** 'Connected' | 'Offline' | 'Unauthorized' | … | 'Unknown' when not reported. */
  status: string;
  /** 'USB' | 'TCP' | … when reported by `-v`. */
  connection?: string;
  /** Device model, populated by getDeviceInfo (not by the bare target list). */
  model?: string;
}

// Recognised tokens in `hdc list targets -v` rows. Parsing is positional-agnostic
// (we scan the row's tokens) so it tolerates hdc version differences in column order.
const STATUS_TOKENS = new Set([
  'Connected',
  'Offline',
  'Unauthorized',
  'Authorizing',
  'Disconnected',
  'Recovery',
]);
const CONNECTION_TOKENS = new Set(['USB', 'TCP', 'UART', 'BT', 'UNKNOWN']);

/**
 * Parse the output of `hdc list targets -v` into structured rows. The first token
 * of each non-empty row is the connect key (serial); connection/status are matched
 * by keyword among the remaining tokens. `[Empty]` (no devices) yields `[]`.
 */
export function parseDeviceList(stdout: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[Empty]')) continue;
    const cols = trimmed.split(/\s+/);
    const serial = cols[0];
    if (!serial) continue;
    const rest = cols.slice(1);
    const connection = rest.find((c) => CONNECTION_TOKENS.has(c));
    const status = rest.find((c) => STATUS_TOKENS.has(c)) ?? 'Unknown';
    const info: DeviceInfo = { serial, status };
    if (connection) info.connection = connection;
    devices.push(info);
  }
  return devices;
}

/** List connected hdc targets via `hdc list targets -v`. Empty list when none. */
export async function listDevices(
  config: ConfigProvider,
  opts: { timeoutMs?: number; logger?: Logger } = {},
): Promise<DeviceInfo[]> {
  const res = await hdcExec({
    config,
    args: ['list', 'targets', '-v'],
    timeoutMs: opts.timeoutMs ?? 10_000,
    logger: opts.logger,
  });
  return parseDeviceList(res.stdout);
}

/**
 * Resolve which device serial to address: an explicit `serial` wins, then the
 * `ONIRO_DEVICE_SERIAL` / `DEVICE_SERIAL` env vars, then the single connected
 * device. Throws when none or more than one is connected and nothing was specified.
 */
export async function selectDevice(
  config: ConfigProvider,
  serial?: string,
  opts: { timeoutMs?: number; logger?: Logger } = {},
): Promise<string> {
  if (serial && serial !== 'auto') return serial;
  const envSerial = process.env.ONIRO_DEVICE_SERIAL || process.env.DEVICE_SERIAL;
  if (envSerial && envSerial !== 'auto') return envSerial;

  const usable = (await listDevices(config, opts)).filter(
    (d) => d.status === 'Connected' || d.status === 'Unknown',
  );
  if (usable.length === 1) return usable[0]!.serial;
  if (usable.length === 0) {
    throw new OniroError('No connected device found. Connect a device/emulator or set ONIRO_DEVICE_SERIAL.');
  }
  throw new OniroError(
    `Multiple devices connected (${usable.map((d) => d.serial).join(', ')}). ` +
      'Set ONIRO_DEVICE_SERIAL to choose one.',
  );
}
