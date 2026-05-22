import type { ProgressReporter } from '@oniroproject/core';

/**
 * Line-per-update progress reporter, designed for machine consumers and log scrapers.
 * Format: `[progress NN%] message` (or `[progress] message` if no percent is known).
 * Updates that don't change the percent and don't carry a message are suppressed
 * to keep output volume reasonable on chatty downloads.
 */
export function createCliProgress(): ProgressReporter {
  let total = 0;
  let lastEmitted = -1;
  let lastMessage = '';
  return {
    report({ message, increment }) {
      if (typeof increment === 'number') total = Math.min(100, total + increment);
      const pct = total > 0 ? Math.round(total) : null;
      const msg = message ?? lastMessage;
      // Drop redundant updates: same message, same percent.
      if (pct === lastEmitted && msg === lastMessage) return;
      const prefix = pct === null ? '[progress]' : `[progress ${pct}%]`;
      process.stderr.write(`${prefix} ${msg}\n`);
      lastEmitted = pct ?? lastEmitted;
      if (message) lastMessage = message;
    },
  };
}
