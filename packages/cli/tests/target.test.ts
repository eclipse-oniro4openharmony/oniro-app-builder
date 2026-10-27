import { describe, expect, it } from 'vitest';
import { selectorFrom, targetIndexFrom } from '../src/lib/target.js';

describe('selectorFrom', () => {
  it('is undefined when no target flag is given', () => {
    expect(selectorFrom({})).toBeUndefined();
  });

  it('builds a selector from the target flags', () => {
    expect(selectorFrom({ target: 'OK', targetType: 'Button' })).toEqual({ text: 'OK', id: undefined, type: 'Button' });
    expect(selectorFrom({ targetId: 'email' })).toEqual({ text: undefined, id: 'email', type: undefined });
  });
});

describe('targetIndexFrom', () => {
  it('parses a non-negative integer', () => {
    expect(targetIndexFrom({})).toBeUndefined();
    expect(targetIndexFrom({ targetIndex: '0' })).toBe(0);
    expect(targetIndexFrom({ targetIndex: '2' })).toBe(2);
  });

  it('rejects anything else', () => {
    for (const bad of ['-1', '1.5', 'first']) {
      expect(() => targetIndexFrom({ targetIndex: bad })).toThrow(/non-negative integer/);
    }
  });
});
