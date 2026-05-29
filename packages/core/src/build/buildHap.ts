import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { runHvigorw } from './runHvigorw.js';
import { ensureOhModules } from './ohpm.js';
import { discoverHaps, type ModuleHaps } from './discoverHaps.js';

export interface BuildHapOptions {
  config: ConfigProvider;
  projectDir: string;
  product?: string;
  module?: string;
  /** Forwarded as hvigor `buildMode` (e.g. release, debug). */
  mode?: string;
  /** hvigor task. Default `assembleHap`. */
  task?: string;
  /** Run `ohpm install --all` first when `oh_modules/` is missing. Default true. */
  autoInstallDeps?: boolean;
  /** Build modules in parallel. Default true (see runHvigorw). */
  parallel?: boolean;
  abortSignal?: AbortSignal;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  logger?: Logger;
}

export interface BuildHapResult {
  exitCode: number;
  durationMs: number;
  /** Built HAPs grouped by module folder. */
  discoveredHaps: Record<string, ModuleHaps>;
  warnings: string[];
}

/**
 * High-level build orchestration: ensure deps → run hvigorw → discover the
 * produced HAPs. The single call the CLI and MCP want; `runHvigorw` stays a raw
 * single-spawn primitive.
 */
export async function buildHap(opts: BuildHapOptions): Promise<BuildHapResult> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'build');
  const warnings: string[] = [];
  const start = Date.now();

  if (opts.autoInstallDeps !== false) {
    const r = await ensureOhModules({
      config: opts.config,
      projectDir: opts.projectDir,
      abortSignal: opts.abortSignal,
      onOutput: opts.onOutput,
      logger: opts.logger,
    });
    if (r.installed) logger.info('ran ohpm install --all (oh_modules was missing)');
  }

  const { exitCode } = await runHvigorw({
    config: opts.config,
    projectDir: opts.projectDir,
    product: opts.product,
    module: opts.module,
    buildMode: opts.mode,
    task: opts.task,
    parallel: opts.parallel,
    abortSignal: opts.abortSignal,
    onOutput: opts.onOutput,
    logger: opts.logger,
  });

  const discoveredHaps = await discoverHaps({ projectDir: opts.projectDir });
  const anySigned = Object.values(discoveredHaps).some((m) => m.signed.length > 0);
  if (!anySigned) {
    warnings.push(
      'No signed HAPs found — configure signingConfigs in build-profile.json5 (unsigned HAPs are rejected by most devices).',
    );
  }

  return { exitCode, durationMs: Date.now() - start, discoveredHaps, warnings };
}
