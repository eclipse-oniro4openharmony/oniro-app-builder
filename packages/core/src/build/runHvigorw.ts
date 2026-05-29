import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, CmdToolsNotInstalledError, OniroError } from '../ports/errors.js';
import { getHvigorwPath, getOhosBaseSdkHome, getCmdToolsPath } from '../sdk/paths.js';

export interface RunHvigorwOptions {
  config: ConfigProvider;
  projectDir: string;
  /** Forwarded as `-p product=<product>`. Default `default`. */
  product?: string;
  /** Forwarded as `-p module=<module>` when set. */
  module?: string;
  /** Forwarded as `-p buildMode=<mode>` when set. */
  buildMode?: string;
  /** hvigor task to run. Default `assembleHap`. */
  task?: string;
  /** Extra raw args appended after the standard ones. */
  extraArgs?: readonly string[];
  /**
   * Build modules in parallel. Default `true`. Pass `false` to add `--no-parallel`
   * for projects that require serial builds.
   */
  parallel?: boolean;
  /** Abort the build; rejects with CancelledError and kills the hvigorw process. */
  abortSignal?: AbortSignal;
  logger?: Logger;
  /**
   * Optional callback for each stdout/stderr chunk, lets callers stream output
   * to a terminal or webview without buffering. Lines also flow through `logger`.
   */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface RunHvigorwResult {
  exitCode: number;
}

/**
 * Build the hvigorw argv. Pure (no I/O) so it is unit-testable. `--no-parallel`
 * is added ONLY when `parallel === false` — builds are parallel by default.
 */
export function buildHvigorwArgs(opts: {
  task?: string;
  product?: string;
  module?: string;
  buildMode?: string;
  parallel?: boolean;
  extraArgs?: readonly string[];
}): string[] {
  const args: string[] = [opts.task ?? 'assembleHap', '--mode', 'module'];
  args.push('-p', `product=${opts.product ?? 'default'}`);
  if (opts.module) args.push('-p', `module=${opts.module}`);
  if (opts.buildMode) args.push('-p', `buildMode=${opts.buildMode}`);
  args.push('--stacktrace', '--no-daemon');
  if (opts.parallel === false) args.push('--no-parallel');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/**
 * Run the project's `hvigorw` wrapper. Replaces the extension's vscode-tasks indirection
 * and the bash CLI's chained `clean` + `assembleHap` calls with a single direct spawn.
 */
export function runHvigorw(opts: RunHvigorwOptions): Promise<RunHvigorwResult> {
  const { config, projectDir } = opts;
  const logger = opts.logger ?? noopLogger;

  if (!fs.existsSync(path.join(projectDir, 'build-profile.json5'))) {
    throw new OniroError(`Not an OpenHarmony project: ${projectDir} (build-profile.json5 not found).`);
  }
  if (!fs.existsSync(getCmdToolsPath(config))) {
    throw new CmdToolsNotInstalledError(getCmdToolsPath(config));
  }

  const hvigorw = getHvigorwPath(config, projectDir);
  const args = buildHvigorwArgs(opts);

  // Ensure hvigorw is executable on POSIX (project-local copies often aren't after a fresh clone).
  if (process.platform !== 'win32') {
    try { fs.chmodSync(hvigorw, 0o755); } catch { /* best effort */ }
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OHOS_BASE_SDK_HOME: getOhosBaseSdkHome(config),
  };

  return new Promise((resolve, reject) => {
    if (opts.abortSignal?.aborted) {
      reject(new CancelledError('hvigorw build cancelled.'));
      return;
    }
    logger.info(`[build] ${hvigorw} ${args.join(' ')}`);
    const child = spawn(hvigorw, args, { cwd: projectDir, env, shell: false });
    let settled = false;
    const cleanup = (): void => opts.abortSignal?.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new CancelledError('hvigorw build cancelled.'));
    };
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      opts.onOutput?.(text, 'stdout');
      logger.info(text.trimEnd());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      opts.onOutput?.(text, 'stderr');
      logger.warn(text.trimEnd());
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OniroError(`Failed to start hvigorw: ${err.message}`, err));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const exitCode = code ?? 1;
      if (exitCode === 0) resolve({ exitCode });
      else reject(new OniroError(`hvigorw exited with code ${exitCode}`));
    });
  });
}
