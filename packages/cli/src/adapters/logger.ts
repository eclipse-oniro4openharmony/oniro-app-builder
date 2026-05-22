import type { Logger } from '@oniroproject/core';

/**
 * Stderr-only logger. All diagnostic output goes to stderr so command stdout
 * stays clean for machine consumers (json results, paths, etc.).
 *
 * Debug lines are suppressed unless `ONIRO_DEBUG=1`.
 */
export function createCliLogger(): Logger {
  const debugEnabled = process.env.ONIRO_DEBUG === '1' || process.env.ONIRO_DEBUG === 'true';
  return {
    debug(m) {
      if (debugEnabled) process.stderr.write(`[debug] ${m}\n`);
    },
    info(m) {
      process.stderr.write(`${m}\n`);
    },
    warn(m) {
      process.stderr.write(`[warn] ${m}\n`);
    },
    error(m) {
      process.stderr.write(`[error] ${m}\n`);
    },
  };
}
