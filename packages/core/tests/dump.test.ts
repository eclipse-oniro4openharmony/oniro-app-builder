import { describe, expect, it } from 'vitest';
import { parseBounds, pruneLayout, type RawLayoutNode, type LayoutNode } from '../src/hdc/dump.js';

describe('parseBounds', () => {
  it('parses "[x1,y1][x2,y2]"', () => {
    expect(parseBounds('[0,0][100,200]')).toEqual([0, 0, 100, 200]);
    expect(parseBounds('[-5,10][20,30]')).toEqual([-5, 10, 20, 30]);
  });

  it('returns null for malformed or missing input', () => {
    expect(parseBounds('garbage')).toBeNull();
    expect(parseBounds(undefined)).toBeNull();
    expect(parseBounds('[0,0]')).toBeNull();
  });
});

describe('pruneLayout', () => {
  const display = { width: 1080, height: 2340 };

  it('normalizes bounds/center to 0–1 and keeps signal-bearing nodes', () => {
    const raw: RawLayoutNode = {
      attributes: { type: 'Text', text: 'Hello', bounds: '[0,0][100,50]', clickable: 'true' },
    };
    const pruned = pruneLayout(raw, display) as LayoutNode;
    expect(pruned.text).toBe('Hello');
    expect(pruned.type).toBe('Text');
    expect(pruned.click).toBe(true);
    expect(pruned.b).toEqual([0, 0, 0.093, 0.021]);
    expect(pruned.c).toEqual([0.046, 0.011]);
  });

  it('collapses a structural wrapper with one child up to that child', () => {
    const raw: RawLayoutNode = {
      attributes: { type: 'root' },
      children: [
        {
          attributes: { type: 'Stack', bounds: '[0,0][1080,2340]' },
          children: [{ attributes: { type: 'Button', text: 'OK', bounds: '[0,0][100,100]' } }],
        },
      ],
    };
    const pruned = pruneLayout(raw, display) as LayoutNode;
    // root (type 'root' = no signal) and Stack (structural) both collapse → the Button surfaces.
    expect(pruned.type).toBe('Button');
    expect(pruned.text).toBe('OK');
  });

  it('drops nodes with no signal and no children', () => {
    expect(pruneLayout({ attributes: { type: 'Stack' } }, display)).toBeNull();
  });

  it('omits bounds when no display size is available', () => {
    const pruned = pruneLayout({ attributes: { type: 'Text', text: 'x', bounds: '[0,0][10,10]' } }, null) as LayoutNode;
    expect(pruned.b).toBeUndefined();
    expect(pruned.text).toBe('x');
  });

  it('returns an array when a structural wrapper has multiple signal children', () => {
    const raw: RawLayoutNode = {
      attributes: { type: 'Column' },
      children: [
        { attributes: { type: 'Text', text: 'a', bounds: '[0,0][10,10]' } },
        { attributes: { type: 'Text', text: 'b', bounds: '[0,10][10,20]' } },
      ],
    };
    const pruned = pruneLayout(raw, display);
    expect(Array.isArray(pruned)).toBe(true);
    expect((pruned as LayoutNode[]).map((n) => n.text)).toEqual(['a', 'b']);
  });
});
