import { describe, expect, it } from 'vitest';
import { performInput, waitForTarget } from '../src/hdc/uiActions.js';

// These cases are rejected before any device I/O, so a stub config is enough.
const config = {} as never;

describe('performInput (argument validation)', () => {
  it('rejects fractions outside 0–1', async () => {
    await expect(performInput({ config, type: 'click', fx: 1.5, fy: 0.5 })).rejects.toThrow(/--fx must be a fraction between 0 and 1; got 1.5/);
    await expect(performInput({ config, type: 'swipe', fx: 0.5, fy: 0.5, fx2: 0.5, fy2: -0.1 })).rejects.toThrow(/--fy2/);
  });

  it('requires both halves of a point', async () => {
    await expect(performInput({ config, type: 'click', fx: 0.5 })).rejects.toThrow(/Give both --fx and --fy/);
    await expect(performInput({ config, type: 'click', pxY: 10 })).rejects.toThrow(/Give both --x and --y/);
  });

  it('rejects a start point given more than one way', async () => {
    await expect(performInput({ config, type: 'click', fx: 0.5, fy: 0.5, pxX: 1, pxY: 2 })).rejects.toThrow(/start point one way/);
    await expect(performInput({ config, type: 'click', target: { text: 'OK' }, pxX: 1, pxY: 2 })).rejects.toThrow(
      /start point one way/,
    );
  });

  it('rejects an end point given both as fractions and pixels', async () => {
    await expect(
      performInput({ config, type: 'swipe', pxX: 1, pxY: 2, fx2: 0.5, fy2: 0.5, pxX2: 3, pxY2: 4 }),
    ).rejects.toThrow(/end point one way/);
  });
});

describe('waitForTarget', () => {
  it('rejects an empty selector or a blank text before polling', async () => {
    await expect(waitForTarget({ config, selector: {}, timeoutMs: 100 })).rejects.toThrow(/text, id, or type/);
    await expect(waitForTarget({ config, selector: { text: '' }, timeoutMs: 100 })).rejects.toThrow(/must not be blank/);
  });
});
