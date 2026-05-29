import { spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { CancelledError, CommandFailedError, OniroError } from '../ports/errors.js';
import { getHdcPath } from '../sdk/paths.js';

/** Result of a spawned command. `code` is the process exit code (-1 if it was killed). */
export interface HdcExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Streamed output callback, invoked per stdout/stderr chunk as it arrives. */
export type OutputSink = (chunk: string, stream: 'stdout' | 'stderr') => void;

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

    const child = spawn(command, [...args], { cwd, env, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new CancelledError(`Command aborted: ${command} ${args.join(' ')}`));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    abortSignal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      onOutput?.(s, 'stdout');
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      onOutput?.(s, 'stderr');
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

export interface HdcExecOptions {
  config: ConfigProvider;
  /** Args passed to hdc verbatim, e.g. `['shell','aa','start','-a',ability,'-b',bundle]`. */
  args: readonly string[];
  /** Device serial; when set, prepends `['-t', serial]`. */
  deviceSerial?: string;
  /** Default 60_000. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onOutput?: OutputSink;
  logger?: Logger;
}

/**
 * Run `hdc [-t <serial>] <args...>`. Resolves with `{ code, stdout, stderr }`
 * for any exit code; use {@link ensureOk} to throw on non-zero.
 */
export function hdcExec(opts: HdcExecOptions): Promise<HdcExecResult> {
  const hdc = getHdcPath(opts.config);
  const argv = opts.deviceSerial ? ['-t', opts.deviceSerial, ...opts.args] : [...opts.args];
  return runProcess({
    command: hdc,
    args: argv,
    timeoutMs: opts.timeoutMs,
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
    logger: opts.logger,
  });
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
    throw new CommandFailedError(command, result.code, result.stderr.trim());
  }
  return result;
}
