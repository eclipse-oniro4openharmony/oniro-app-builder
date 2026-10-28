import * as fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { CancelledError, CommandFailedError, OniroError } from '../ports/errors.js';
import { getHdcPath } from '../sdk/paths.js';
import { killProcessTree, needsCmdWrapper, spawnCompat } from './spawnCompat.js';

/** Result of a spawned command. `code` is the process exit code (-1 if it was killed). */
export interface HdcExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Streamed output callback, invoked per stdout/stderr chunk as it arrives. */
export type OutputSink = (chunk: string, stream: 'stdout' | 'stderr') => void;

/** Message of an unknown thrown value, for uniform spawn-failure reporting. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RunProcessOptions {
  /** Executable to spawn. */
  command: string;
  /** Args passed verbatim (spawn runs with `shell: false`, so no shell parsing). */
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many ms and reject. Default 60_000. */
  timeoutMs?: number;
  /** Abort the process; rejects with CancelledError. */
  abortSignal?: AbortSignal;
  /** Receive stdout/stderr chunks as they arrive (in addition to the buffered result). */
  onOutput?: OutputSink;
  /** Reserved for future scoped diagnostics; the buffered result is returned regardless. */
  logger?: Logger;
}

/**
 * Spawn an arbitrary process with `shell: false` and collect its output. The
 * single low-level primitive every other command in the package builds on —
 * because args are passed as an array and never interpolated into a shell
 * string, command construction is injection-safe by construction.
 *
 * The one exception is a Windows batch wrapper (`.bat`/`.cmd`, how the
 * OpenHarmony command-line tools ship there), which the OS cannot execute
 * directly: those go through `cmd.exe` with every argument individually
 * escaped — see {@link spawnCompat}. The array-in, no-word-splitting contract
 * is preserved.
 *
 * Resolves with `{ code, stdout, stderr }` for ANY exit code (callers opt into
 * throw-on-non-zero via {@link ensureOk}). Rejects only on spawn failure
 * (e.g. missing binary), timeout, or abort.
 */
export function runProcess(opts: RunProcessOptions): Promise<HdcExecResult> {
  const { command, args, cwd, env, onOutput } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const { abortSignal } = opts;

  return new Promise<HdcExecResult>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new CancelledError(`Command aborted before start: ${command}`));
      return;
    }

    // A batch wrapper runs through cmd.exe, which cannot report ENOENT for the
    // wrapper itself — it would exit 1 with "is not recognized as an internal
    // or external command". Check up front so a missing tool keeps surfacing as
    // a spawn failure on Windows too.
    if (needsCmdWrapper(command) && !fs.existsSync(command)) {
      reject(new OniroError(`Failed to spawn ${command}: ENOENT (no such file)`));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnCompat(command, args, { cwd, env });
    } catch (err) {
      // spawn() can also fail synchronously (EINVAL, EACCES). Report it the
      // same way as the asynchronous 'error' event so callers see one message.
      reject(new OniroError(`Failed to spawn ${command}: ${errorMessage(err)}`, err));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const cleanup = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessTree(child);
      reject(new CancelledError(`Command aborted: ${command} ${args.join(' ')}`));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    abortSignal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => {
      const s = stdoutDecoder.write(d);
      stdout += s;
      if (s) onOutput?.(s, 'stdout');
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = stderrDecoder.write(d);
      stderr += s;
      if (s) onOutput?.(s, 'stderr');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OniroError(`Failed to spawn ${command}: ${err.message}`, err));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      stdout += stdoutTail;
      stderr += stderrTail;
      if (stdoutTail) onOutput?.(stdoutTail, 'stdout');
      if (stderrTail) onOutput?.(stderrTail, 'stderr');
      if (timedOut) {
        reject(
          new OniroError(
            `Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}` +
              (stderr.trim() ? `\n${stderr.trim()}` : ''),
          ),
        );
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * The device to address: an explicit serial wins, then the `ONIRO_DEVICE_SERIAL` /
 * `DEVICE_SERIAL` env vars. `auto`, or nothing at all, leaves the choice to hdc,
 * which only works while a single target is connected.
 */
export function resolveDeviceSerial(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (explicit && explicit !== 'auto') return explicit;
  const fromEnv = env.ONIRO_DEVICE_SERIAL || env.DEVICE_SERIAL;
  return fromEnv && fromEnv !== 'auto' ? fromEnv : undefined;
}

/** `['-t', <serial>]` for the device {@link resolveDeviceSerial} picks, or `[]` to let hdc choose. */
export function hdcTargetArgs(explicit?: string): string[] {
  const serial = resolveDeviceSerial(explicit);
  return serial ? ['-t', serial] : [];
}

/**
 * hdc subcommands served by the hdc server itself rather than a device. They only
 * take `-t` when the caller names a device explicitly, never from the env var.
 */
const HOST_COMMANDS = new Set(['list', 'tconn', 'start', 'kill', 'version', 'checkserver']);

/** The `-t <serial>` prefix for `hdc <args...>`, following {@link HdcExecOptions.deviceSerial}'s rules. */
export function hdcTargetArgsFor(args: readonly string[], explicit?: string): string[] {
  if (HOST_COMMANDS.has(args[0] ?? '')) return explicit ? ['-t', explicit] : [];
  return hdcTargetArgs(explicit);
}

/**
 * The `[Fail]…` line hdc printed instead of running the command, or null. hdc
 * exits 0 even then: `[Fail]ExecuteCommand need connect-key?` (several targets
 * and no `-t`), `[Fail]Not match target founded` (unknown serial), a failed file
 * transfer. Only the first line of output counts, so device-side output further
 * down that happens to contain the marker is left alone. Pure/testable.
 */
export function hdcClientFailure(output: string): string | null {
  const first = output.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
  return first.startsWith('[Fail]') ? first : null;
}

export interface HdcExecOptions {
  config: ConfigProvider;
  /** Args passed to hdc verbatim, e.g. `['shell','aa','start','-a',ability,'-b',bundle]`. */
  args: readonly string[];
  /**
   * Device serial; prepends `['-t', serial]`. When unset, `ONIRO_DEVICE_SERIAL`
   * applies (see {@link resolveDeviceSerial}), except for hdc server commands
   * such as `list targets` and `tconn`.
   */
  deviceSerial?: string;
  /** Default 60_000. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onOutput?: OutputSink;
  logger?: Logger;
}

/**
 * Run `hdc [-t <serial>] <args...>`. Resolves with `{ code, stdout, stderr }`
 * for any exit code; use {@link ensureOk} to throw on non-zero. A `[Fail]` line
 * from hdc itself is reported as exit code 1 (see {@link hdcClientFailure}).
 */
export async function hdcExec(opts: HdcExecOptions): Promise<HdcExecResult> {
  const hdc = getHdcPath(opts.config);
  const res = await runProcess({
    command: hdc,
    args: [...hdcTargetArgsFor(opts.args, opts.deviceSerial), ...opts.args],
    timeoutMs: opts.timeoutMs,
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
    logger: opts.logger,
  });
  if (res.code === 0 && hdcClientFailure(`${res.stdout}\n${res.stderr}`)) return { ...res, code: 1 };
  return res;
}

export interface HdcShellOptions extends Omit<HdcExecOptions, 'args'> {
  /** A single shell command, run as `hdc shell <command>` (one argv element — not host word-split). */
  command: string;
}

/** Convenience wrapper for `hdc shell <command>`. */
export function shell(opts: HdcShellOptions): Promise<HdcExecResult> {
  const { command, ...rest } = opts;
  return hdcExec({ ...rest, args: ['shell', command] });
}

/**
 * Throw a typed {@link CommandFailedError} when `result.code !== 0`, otherwise
 * return the result unchanged. Lets callers opt into throw-semantics.
 */
export function ensureOk(result: HdcExecResult, command: string): HdcExecResult {
  if (result.code !== 0) {
    throw new CommandFailedError(command, result.code, withTargetHint(result.stderr.trim() || result.stdout.trim()));
  }
  return result;
}

/** Append how to pick a device when hdc refused to choose between several. */
function withTargetHint(detail: string): string {
  if (!/need connect-key|Not match target/i.test(detail)) return detail;
  return (
    `${detail}\nMore than one target is connected, or the serial is unknown: pass --device <serial> ` +
    'or set ONIRO_DEVICE_SERIAL to one listed by `oniro-app devices`.'
  );
}

/** Matches the exit-code marker {@link shellChecked} appends. */
const REMOTE_RC_RE = /__ONIRO_RC=(-?\d+)__/g;

/**
 * Parse the exit-code marker appended by {@link shellChecked}. Pure/testable.
 * Returns the remote exit code plus stdout with every marker occurrence
 * stripped, or `null` when no marker is present (the command was killed/timed
 * out, or the device shell never reached the trailing `echo`).
 */
export function parseRemoteExit(stdout: string): { code: number; stdout: string } | null {
  let code: number | null = null;
  for (const m of stdout.matchAll(REMOTE_RC_RE)) code = Number(m[1]);
  if (code === null) return null;
  return { code, stdout: stdout.replace(REMOTE_RC_RE, '').replace(/[ \t\r\n]+$/, '') };
}

/**
 * Like {@link shell}, but recovers the REMOTE command's exit status.
 *
 * `hdc shell "<cmd>"` reports hdc's OWN exit code (≈ always 0) regardless of
 * whether `<cmd>` succeeded on the device — so on-device failures (`uinput`
 * rejecting its args, a `bm install` error, a missing binary) otherwise look
 * like success. We append an exit-code marker, parse it back out, and report
 * it as `code`, with the marker stripped from stdout. Pair with
 * {@link ensureRemoteOk} to throw on a non-zero remote exit.
 */
export async function shellChecked(opts: HdcShellOptions): Promise<HdcExecResult> {
  const { command, ...rest } = opts;
  const res = await hdcExec({ ...rest, args: ['shell', `${command}; echo "__ONIRO_RC=$?__"`] });
  const parsed = parseRemoteExit(res.stdout);
  if (!parsed) return res; // marker missing — fall back to hdc's own exit code
  return { code: parsed.code, stdout: parsed.stdout, stderr: res.stderr };
}

/**
 * Throw a typed {@link CommandFailedError} on a non-zero result, preferring
 * stderr but falling back to stdout for the detail — device tools like
 * `uinput`/`uitest` print their errors to stdout, not stderr.
 */
export function ensureRemoteOk(result: HdcExecResult, command: string): HdcExecResult {
  if (result.code !== 0) {
    throw new CommandFailedError(command, result.code, withTargetHint(result.stderr.trim() || result.stdout.trim()));
  }
  return result;
}
