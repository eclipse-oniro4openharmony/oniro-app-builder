import type { Logger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';

export interface WaitForConditionOptions {
  /** Resolves true when the condition is satisfied. Called once per poll. */
  probe: () => Promise<boolean>;
  /** Overall deadline. */
  timeoutMs: number;
  /** Poll interval. Default 2000. */
  pollMs?: number;
  /** Abort the wait; rejects with CancelledError. */
  abortSignal?: AbortSignal;
  /** Called every `heartbeatEvery` attempts (default 6) with progress info. */
  onHeartbeat?: (attempt: number, remainingMs: number) => void;
  heartbeatEvery?: number;
  logger?: Logger;
  /** Message for the timeout error. */
  timeoutMessage?: string;
}

/** Sleep `ms`, rejecting early (CancelledError) if `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Wait cancelled.'));
      return;
    }
    const onAbort = (): void => {
      cleanup();
      reject(new CancelledError('Wait cancelled.'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Generic deadline + poll + heartbeat loop. Calls `probe()` every `pollMs` until
 * it resolves true (→ resolve) or the deadline passes (→ throw OniroError).
 * A probe that throws is treated as "not yet" (the loop keeps polling) — this is
 * what lets device waits tolerate transient hdc disconnects mid-reboot. Aborting
 * the signal rejects with CancelledError.
 *
 * Extracted from the emulator hdc-wait loop so device lifecycle helpers share it.
 */
export async function waitForCondition(opts: WaitForConditionOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 2000;
  const heartbeatEvery = opts.heartbeatEvery ?? 6;
  const deadline = Date.now() + opts.timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (opts.abortSignal?.aborted) throw new CancelledError('Wait cancelled.');
    attempt++;

    let ok = false;
    try {
      ok = await opts.probe();
    } catch {
      ok = false; // transient failure (e.g. hdc disconnect) — keep polling
    }
    if (ok) return;

    if (opts.onHeartbeat && attempt % heartbeatEvery === 0) {
      opts.onHeartbeat(attempt, Math.max(0, deadline - Date.now()));
    }
    await delay(pollMs, opts.abortSignal);
  }

  throw new OniroError(opts.timeoutMessage ?? `Condition not met within ${opts.timeoutMs}ms.`);
}
