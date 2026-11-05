import type { Logger } from '@oniroproject/core';

/**
 * Run `fn` with an abort signal that the first Ctrl+C fires, so the command's
 * cleanup (stopping a device-side capture, restoring a setting) still runs; a
 * second Ctrl+C exits at once.
 */
export async function withInterrupt<T>(logger: Logger, what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSigint = (): void => {
    if (controller.signal.aborted) process.exit(130);
    logger.info(`${what}… (Ctrl+C again to quit at once)`);
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  try {
    return await fn(controller.signal);
  } finally {
    process.off('SIGINT', onSigint);
  }
}
