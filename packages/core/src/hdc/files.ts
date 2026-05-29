import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { hdcExec, ensureOk, type OutputSink } from './exec.js';

export interface SendFileOptions {
  config: ConfigProvider;
  /** Local source path. */
  local: string;
  /** Remote destination path on the device. */
  remote: string;
  deviceSerial?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onOutput?: OutputSink;
  logger?: Logger;
}

/** Push a local file to the device via `hdc file send <local> <remote>`. */
export async function sendFile(opts: SendFileOptions): Promise<void> {
  const res = await hdcExec({
    config: opts.config,
    args: ['file', 'send', opts.local, opts.remote],
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 600_000,
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
    logger: opts.logger,
  });
  ensureOk(res, `hdc file send ${opts.local} ${opts.remote}`);
}

export interface RecvFileOptions {
  config: ConfigProvider;
  /** Remote source path on the device. */
  remote: string;
  /** Local destination path. */
  local: string;
  deviceSerial?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onOutput?: OutputSink;
  logger?: Logger;
}

/** Pull a file from the device via `hdc file recv <remote> <local>`. */
export async function recvFile(opts: RecvFileOptions): Promise<void> {
  const res = await hdcExec({
    config: opts.config,
    args: ['file', 'recv', opts.remote, opts.local],
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 600_000,
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
    logger: opts.logger,
  });
  ensureOk(res, `hdc file recv ${opts.remote} ${opts.local}`);
}
