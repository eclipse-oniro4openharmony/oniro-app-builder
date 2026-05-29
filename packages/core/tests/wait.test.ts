import { describe, expect, it, vi } from 'vitest';
import { waitForCondition } from '../src/hdc/wait.js';
import { CancelledError, OniroError } from '../src/ports/errors.js';

describe('waitForCondition', () => {
  it('resolves when the probe is immediately true', async () => {
    const probe = vi.fn(async () => true);
    await expect(waitForCondition({ probe, timeoutMs: 1000, pollMs: 5 })).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('polls until the probe becomes true', async () => {
    let n = 0;
    await waitForCondition({ probe: async () => ++n >= 3, timeoutMs: 1000, pollMs: 5 });
    expect(n).toBe(3);
  });

  it('treats a throwing probe as "not yet" and keeps polling', async () => {
    let n = 0;
    const probe = async (): Promise<boolean> => {
      n++;
      if (n < 3) throw new Error('transient hdc disconnect');
      return true;
    };
    await expect(waitForCondition({ probe, timeoutMs: 1000, pollMs: 5 })).resolves.toBeUndefined();
    expect(n).toBe(3);
  });

  it('throws OniroError with the timeout message when never satisfied', async () => {
    await expect(
      waitForCondition({ probe: async () => false, timeoutMs: 40, pollMs: 10, timeoutMessage: 'still not ready' }),
    ).rejects.toThrowError(OniroError);
    await expect(
      waitForCondition({ probe: async () => false, timeoutMs: 40, pollMs: 10, timeoutMessage: 'still not ready' }),
    ).rejects.toThrow(/still not ready/);
  });

  it('rejects with CancelledError when aborted mid-wait', async () => {
    const controller = new AbortController();
    const p = waitForCondition({
      probe: async () => false,
      timeoutMs: 5000,
      pollMs: 10,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });

  it('fires the heartbeat every N attempts', async () => {
    let n = 0;
    const onHeartbeat = vi.fn();
    await waitForCondition({ probe: async () => ++n >= 5, timeoutMs: 2000, pollMs: 3, heartbeatEvery: 2, onHeartbeat });
    // attempts 2 and 4 fire; attempt 5 returns true before its heartbeat check.
    expect(onHeartbeat).toHaveBeenCalledTimes(2);
  });
});
