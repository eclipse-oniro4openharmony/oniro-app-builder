import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { toLongPath } from '../sdk/paths.js';
import { hdcExec, ensureOk, ensureRemoteOk, shellChecked, type OutputSink } from './exec.js';

/**
 * A host path in the form hdc understands: absolute, with native separators and,
 * on Windows, no 8.3 short names. hdc treats a forward-slash Windows path such as
 * `C:/Users/me/x.txt` as relative and joins it onto the current directory. The
 * last component may not exist yet (a `recv` destination).
 */
export function normaliseLocalPath(local: string): string {
  const abs = path.resolve(local);
  const long = toLongPath(abs);
  return long !== abs ? long : path.join(toLongPath(path.dirname(abs)), path.basename(abs));
}

/**
 * Reject a device path that a Windows shell already rewrote into a host path:
 * Git Bash turns `/data/local/tmp/x` into `C:/Program Files/Git/data/local/tmp/x`
 * before the CLI sees it. Device paths never start with a drive letter.
 */
export function assertDevicePath(remote: string): void {
  if (/^[A-Za-z]:[\\/]/.test(remote)) {
    throw new OniroError(
      `The device path ${remote} is a Windows path. Git Bash rewrites arguments that start with /: ` +
        'run the command with MSYS_NO_PATHCONV=1, or from PowerShell or cmd.',
    );
  }
}

/** Where `hdc shell` sees an app's el2 sandbox; the app itself sees it as `/data/storage/el2/base`. */
export function appSandboxDir(bundle: string): string {
  return `/data/app/el2/100/base/${bundle}`;
}

/** Quote a string for the device's POSIX shell. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface SendFileOptions {
  config: ConfigProvider;
  /** Local source path. */
  local: string;
  /**
   * Remote destination path on the device. With `bundle`, a relative path is
   * resolved inside that app's sandbox (`files/x` is the app's application-level
   * filesDir, `haps/entry/files/x` the entry module's).
   */
  remote: string;
  /**
   * Push into this app's sandbox and give the file to the app's user afterwards:
   * hdc writes files as root, which the app cannot read until they are chowned.
   */
  bundle?: string;
  deviceSerial?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onOutput?: OutputSink;
  logger?: Logger;
}

/**
 * Push a local file to the device via `hdc file send <local> <remote>`. Returns
 * the device path the file was written to.
 */
export async function sendFile(opts: SendFileOptions): Promise<string> {
  assertDevicePath(opts.remote);
  const local = normaliseLocalPath(opts.local);
  const sandbox = opts.bundle ? appSandboxDir(opts.bundle) : undefined;
  const remote = sandbox && !opts.remote.startsWith('/') ? path.posix.join(sandbox, opts.remote) : opts.remote;
  if (sandbox && !remote.startsWith(`${sandbox}/`)) {
    throw new OniroError(`${remote} is outside the sandbox of ${opts.bundle} (${sandbox}).`);
  }
  const device = { config: opts.config, deviceSerial: opts.deviceSerial, logger: opts.logger };

  if (sandbox) {
    const mkdir = `mkdir -p ${shQuote(path.posix.dirname(remote))}`;
    ensureRemoteOk(await shellChecked({ ...device, command: mkdir }), `hdc shell ${mkdir}`);
  }
  const res = await hdcExec({
    ...device,
    args: ['file', 'send', local, remote],
    timeoutMs: opts.timeoutMs ?? 600_000,
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
  });
  ensureOk(res, `hdc file send ${local} ${remote}`);

  if (sandbox) {
    // Everything in the sandbox belongs to the app, so hand over the whole top-level
    // directory the file went into: that covers the parents mkdir created too.
    const top = path.posix.join(sandbox, path.posix.relative(sandbox, remote).split('/')[0]!);
    const chown = `chown -R "$(stat -c %u:%g ${shQuote(sandbox)})" ${shQuote(top)}`;
    ensureRemoteOk(await shellChecked({ ...device, command: chown }), `hdc shell ${chown}`);
  }
  return remote;
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
  assertDevicePath(opts.remote);
  const local = normaliseLocalPath(opts.local);
  const res = await hdcExec({
    config: opts.config,
    args: ['file', 'recv', opts.remote, local],
    deviceSerial: opts.deviceSerial,
    timeoutMs: opts.timeoutMs ?? 600_000,
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
    logger: opts.logger,
  });
  ensureOk(res, `hdc file recv ${opts.remote} ${local}`);
}
