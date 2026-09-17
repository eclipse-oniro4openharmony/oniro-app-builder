import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { runProcess, ensureOk, type HdcExecResult, type OutputSink } from '../hdc/exec.js';
import { getOhpmPath } from '../sdk/paths.js';

export interface RunOhpmOptions {
  config: ConfigProvider;
  projectDir: string;
  args: readonly string[];
  /**
   * Explicit ohpm binary. HarmonyOS projects pass the one from their own install;
   * when omitted the OpenHarmony command-line tools' ohpm is used.
   */
  ohpmPath?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onOutput?: OutputSink;
  logger?: Logger;
}

/** Run `ohpm <args>` in the project directory. Resolves with the raw result (any exit code). */
export function runOhpm(opts: RunOhpmOptions): Promise<HdcExecResult> {
  return runProcess({
    command: opts.ohpmPath ?? getOhpmPath(opts.config),
    args: [...opts.args],
    cwd: opts.projectDir,
    timeoutMs: opts.timeoutMs ?? 600_000,
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
    logger: opts.logger,
  });
}

/**
 * Install dependencies (`ohpm install --all`) only when `oh_modules/` is missing.
 * Returns `{ installed: true }` when it ran. Throws CommandFailedError if the
 * install ran and failed.
 */
export async function ensureOhModules(opts: {
  config: ConfigProvider;
  projectDir: string;
  /** See {@link RunOhpmOptions.ohpmPath}. */
  ohpmPath?: string;
  abortSignal?: AbortSignal;
  onOutput?: OutputSink;
  logger?: Logger;
}): Promise<{ installed: boolean }> {
  if (fs.existsSync(path.join(opts.projectDir, 'oh_modules'))) {
    return { installed: false };
  }
  const res = await runOhpm({
    config: opts.config,
    projectDir: opts.projectDir,
    ohpmPath: opts.ohpmPath,
    args: ['install', '--all'],
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
    logger: opts.logger,
  });
  ensureOk(res, 'ohpm install --all');
  return { installed: true };
}
