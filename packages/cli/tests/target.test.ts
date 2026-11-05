import { describe, expect, it } from 'vitest';
import { selectorFrom, targetIndexFrom, windowIdFrom } from '../src/lib/target.js';

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

describe('selectorFrom with --selector', () => {
  it('parses the DSL and xpath= forms', () => {
    expect(selectorFrom({ selector: 'type=Button,text*=Sign[1]' })).toMatchObject({
      kind: 'dsl',
      index: 1,
      clauses: [
        { key: 'type', op: '=', value: 'Button' },
        { key: 'text', op: '*=', value: 'Sign' },
      ],
    });
    expect(selectorFrom({ selector: 'xpath=//Button[@text="OK"]' })).toMatchObject({ kind: 'xpath' });
  });

  it('refuses to mix --selector with the --target flags or --target-index', () => {
    expect(() => selectorFrom({ selector: 'id=a', target: 'OK' })).toThrow(/either --selector or --target/);
    expect(() => selectorFrom({ selector: 'id=a', targetIndex: '1' })).toThrow(/append \[n\]/);
  });

  it('surfaces parse errors', () => {
    expect(() => selectorFrom({ selector: 'colour=red' })).toThrow(/unknown key "colour"/);
  });
});

describe('windowIdFrom', () => {
  it('parses a window id', () => {
    expect(windowIdFrom({})).toBeUndefined();
    expect(windowIdFrom({ window: '92' })).toBe(92);
    expect(() => windowIdFrom({ window: 'main' })).toThrow(/window id/);
  });
});
