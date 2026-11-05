import { describe, expect, it } from 'vitest';
import type { DumpLayoutResult, LayoutNode } from '../src/hdc/dump.js';
import { boxIoU, diffLayouts, parseLayoutBaseline, summarizeLayout } from '../src/hdc/layoutDiff.js';

const display = { width: 1080, height: 2400 };

function layout(app: LayoutNode[], extraWindows: LayoutNode[] = []): DumpLayoutResult {
  return {
    display,
    tree: {
      children: [
        { type: 'root', bundle: 'com.example.app', b: [0, 0.05, 1, 1], children: app },
        ...extraWindows,
      ],
    },
  };
}

const statusBar: LayoutNode = {
  bundle: 'com.ohos.sceneboard',
  id: 'StatusBar',
  b: [0, 0, 1, 0.05],
  children: [{ type: 'Text', text: '12:35', b: [0.04, 0.01, 0.16, 0.04] }],
};

const signIn = layout(
  [
    { type: 'Text', text: 'Sign in', b: [0.3, 0.1, 0.7, 0.15] },
    { type: 'TextInput', id: 'email', hint: 'you@example.com', click: true, b: [0.1, 0.3, 0.9, 0.35] },
    { type: 'Button', key: 'submit', text: 'Continue', click: true, b: [0.1, 0.5, 0.9, 0.56] },
    { type: 'Image', b: [0.4, 0.7, 0.6, 0.8] },
  ],
  [statusBar],
);

describe('summarizeLayout', () => {
  it('counts elements, content, clickable and text nodes per window and in total', () => {
    const s = summarizeLayout({ ...signIn, keyboard: { shown: false } });
    expect(s.windows).toEqual([
      { window: 'com.example.app', elements: 5, content: 4, clickable: 2, text: 2 },
      { window: 'com.ohos.sceneboard', elements: 2, content: 1, clickable: 0, text: 1 },
    ]);
    expect(s.total).toEqual({ elements: 7, content: 5, clickable: 2, text: 3 });
    expect(s.display).toEqual(display);
    expect(s.keyboard).toEqual({ shown: false });
  });

  it('puts nodes outside any bundle window under (none)', () => {
    const s = summarizeLayout({ display: null, tree: { children: [{ type: 'Text', text: 'x' }] } });
    expect(s.windows).toEqual([{ window: '(none)', elements: 1, content: 1, clickable: 0, text: 1 }]);
  });
});

describe('boxIoU', () => {
  it('is 1 for the same box, 0 for disjoint ones, and the overlap ratio in between', () => {
    expect(boxIoU([0, 0, 1, 1], [0, 0, 1, 1])).toBe(1);
    expect(boxIoU([0, 0, 0.5, 0.5], [0.5, 0.5, 1, 1])).toBe(0);
    expect(boxIoU([0, 0, 0.5, 1], [0, 0, 1, 1])).toBeCloseTo(0.5);
    expect(boxIoU(undefined, undefined)).toBe(1);
    expect(boxIoU([0, 0, 1, 1], undefined)).toBe(0);
  });
});

describe('diffLayouts', () => {
  it('scores an unchanged layout 1 with nothing missing or extra', () => {
    const d = diffLayouts(signIn, signIn);
    expect(d.similarity).toBe(1);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
    expect(d.matched).toHaveLength(7);
    expect(d.moved + d.changed).toBe(0);
  });

  it('matches by id, key, label and type, and reports what changed', () => {
    const now = layout(
      [
        { type: 'Text', text: 'Sign in', b: [0.3, 0.1, 0.7, 0.15] },
        // Moved down.
        { type: 'TextInput', id: 'email', hint: 'you@example.com', click: true, b: [0.1, 0.4, 0.9, 0.45] },
        // Relabelled and disabled: still the same key.
        { type: 'Button', key: 'submit', text: 'Wait…', click: true, disabled: true, b: [0.1, 0.5, 0.9, 0.56] },
        // The image moved slightly: matched by type and overlap.
        { type: 'Image', b: [0.42, 0.7, 0.62, 0.8] },
        { type: 'Text', text: 'Forgot password?', click: true, b: [0.3, 0.9, 0.7, 0.93] },
      ],
      [statusBar],
    );
    const d = diffLayouts(signIn, now);
    const by = (text: string | undefined, id?: string) =>
      d.matched.find((m) => (id ? m.baseline.id === id || m.baseline.key === id : m.baseline.text === text));
    expect(by(undefined, 'email')).toMatchObject({ by: 'id', changed: [] });
    expect(by(undefined, 'email')!.iou).toBe(0);
    expect(by(undefined, 'submit')).toMatchObject({ by: 'key', iou: 1, changed: ['text', 'disabled'] });
    expect(by('Sign in')).toMatchObject({ by: 'text', iou: 1 });
    expect(d.matched.find((m) => m.baseline.type === 'Image')).toMatchObject({ by: 'type' });
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([
      { window: 'com.example.app', type: 'Text', text: 'Forgot password?', b: [0.3, 0.9, 0.7, 0.93] },
    ]);
    expect(d.moved).toBe(2); // email and the image
    expect(d.changed).toBe(1);
    expect(d.similarity).toBeGreaterThan(0.5);
    expect(d.similarity).toBeLessThan(1);
  });

  it('never pairs elements across windows, and lists removed elements as missing', () => {
    const other = layout([{ type: 'Text', text: 'Sign in', b: [0.3, 0.1, 0.7, 0.15] }]);
    const moved: DumpLayoutResult = {
      display,
      tree: { children: [{ type: 'root', bundle: 'com.example.other', children: [{ type: 'Text', text: 'Sign in', b: [0.3, 0.1, 0.7, 0.15] }] }] },
    };
    const d = diffLayouts(other, moved);
    expect(d.matched.some((m) => m.baseline.text === 'Sign in')).toBe(false);
    expect(d.missing.map((n) => n.text)).toContain('Sign in');
    expect(d.extra.map((n) => n.text)).toContain('Sign in');
  });

  it('scores two empty layouts as identical', () => {
    expect(diffLayouts({ display, tree: {} }, { display, tree: {} }).similarity).toBe(1);
  });
});

describe('parseLayoutBaseline', () => {
  it('accepts a dump layout result or a bare tree', () => {
    expect(parseLayoutBaseline(signIn).tree).toBe(signIn.tree);
    expect(parseLayoutBaseline(signIn.tree)).toEqual({ display: null, tree: signIn.tree });
  });

  it('rejects a --raw dump and non-objects', () => {
    expect(() => parseLayoutBaseline({ attributes: { type: 'root' }, children: [] })).toThrow(/--raw/);
    expect(() => parseLayoutBaseline({ display, tree: { attributes: {} } })).toThrow(/--raw/);
    expect(() => parseLayoutBaseline('x')).toThrow(/not a JSON object/);
  });
});
