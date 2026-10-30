import { describe, expect, it } from 'vitest';
import { parseSince } from '../src/lib/logSince.js';

describe('parseSince', () => {
  it('returns undefined when the flag is absent', () => {
    expect(parseSince(undefined)).toBeUndefined();
  });

  it('converts seconds to ms, and "all" to Infinity', () => {
    expect(parseSince('5')).toBe(5000);
    expect(parseSince('0.5')).toBe(500);
    expect(parseSince('all')).toBe(Infinity);
  });

  it('rejects anything else', () => {
    for (const bad of ['', ' ', '-1', '5s', 'Infinity', 'ALL']) {
      expect(() => parseSince(bad)).toThrow(/--since/);
    }
  });
});
