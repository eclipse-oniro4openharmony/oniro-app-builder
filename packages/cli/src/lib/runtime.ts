import type { ConfigProvider, Logger, ProgressReporter } from '@oniroproject/core';
import { createCliLogger } from '../adapters/logger.js';
import { createCliProgress } from '../adapters/progress.js';
import { createEnvConfig } from '../adapters/config.js';

export interface CliRuntime {
  logger: Logger;
  config: ConfigProvider;
  progress: ProgressReporter;
}

let cached: CliRuntime | null = null;

/**
 * Build (and cache) the per-process runtime used by every command. Tests can
 * override the cached runtime via `setRuntime` to inject mocks.
 */
export function getRuntime(): CliRuntime {
  if (!cached) {
    cached = {
      logger: createCliLogger(),
      config: createEnvConfig(),
      progress: createCliProgress(),
    };
  }
  return cached;
}

export function setRuntime(runtime: CliRuntime | null): void {
  cached = runtime;
}
