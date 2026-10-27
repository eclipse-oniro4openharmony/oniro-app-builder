import { describe, expect, it } from 'vitest';
import {
  parseBounds,
  pruneLayout,
  findCoveredNodes,
  flattenLayout,
  findLayoutNodes,
  pickTarget,
  withoutWindow,
  TargetNotFoundError,
  type RawLayoutNode,
  type LayoutNode,
} from '../src/hdc/dump.js';

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

describe('pruneLayout (hint / disabled / covered)', () => {
  const display = { width: 1000, height: 1000 };

  it('keeps a placeholder hint as signal and marks disabled and covered nodes', () => {
    const raw: RawLayoutNode = {
      attributes: { type: 'TextInput', hint: 'you@example.com', enabled: 'false', bounds: '[0,0][100,100]' },
    };
    const pruned = pruneLayout(raw, display, new Set([raw])) as LayoutNode;
    expect(pruned.hint).toBe('you@example.com');
    expect(pruned.disabled).toBe(true);
    expect(pruned.covered).toBe(true);
  });

  it('keeps a hint-only node under a structural type', () => {
    const pruned = pruneLayout({ attributes: { type: 'Stack', hint: 'Search' } }, display) as LayoutNode;
    expect(pruned.hint).toBe('Search');
  });
});

describe('findCoveredNodes', () => {
  const button: RawLayoutNode = { attributes: { type: 'Button', text: 'Home', bounds: '[0,400][1000,500]' } };
  const content = (z?: string): RawLayoutNode => ({
    attributes: { type: 'Column', bounds: '[0,0][1000,1000]', ...(z ? { zIndex: z } : {}) },
    children: [button],
  });
  const overlay = (attrs: Record<string, string> = {}): RawLayoutNode => ({
    attributes: { type: 'Stack', bounds: '[0,0][1000,1000]', backgroundColor: '#80000000', ...attrs },
  });

  it('marks nodes under a later filled overlay', () => {
    const scrim = overlay();
    const covered = findCoveredNodes({ attributes: {}, children: [content(), scrim] });
    expect(covered.has(button)).toBe(true);
    expect(covered.has(scrim)).toBe(false);
  });

  it('paints siblings in zIndex order', () => {
    const covered = findCoveredNodes({ attributes: {}, children: [content('2'), overlay({ zIndex: '1' })] });
    expect(covered.has(button)).toBe(false);
  });

  it('ignores transparent, invisible, and zero-opacity layers', () => {
    for (const attrs of [{ backgroundColor: '#00000000' }, { visible: 'false' }, { opacity: '0' }, { backgroundColor: '' }]) {
      const covered = findCoveredNodes({ attributes: {}, children: [content(), overlay(attrs)] });
      expect(covered.has(button)).toBe(false);
    }
  });

  it('does not let a node cover its ancestors or its descendants', () => {
    const ok: RawLayoutNode = { attributes: { type: 'Button', text: 'OK', bounds: '[400,400][600,600]', backgroundColor: '#FF0000FF' } };
    const dialog: RawLayoutNode = {
      attributes: { type: 'Dialog', bounds: '[100,100][900,900]', backgroundColor: '#FFFFFFFF' },
      children: [ok],
    };
    const covered = findCoveredNodes({ attributes: {}, children: [dialog] });
    expect(covered.has(dialog)).toBe(false);
    expect(covered.has(ok)).toBe(false);
  });

  it('treats a #RRGGBB color as opaque', () => {
    const covered = findCoveredNodes({ attributes: {}, children: [content(), overlay({ backgroundColor: '#FFFFFF' })] });
    expect(covered.has(button)).toBe(true);
  });
});

describe('flattenLayout', () => {
  it('lists nodes depth-first, tags each with its window, and drops empty containers', () => {
    const tree: LayoutNode = {
      children: [
        { bundle: 'com.example.app', children: [{ type: 'Text', text: 'a' }] },
        { bundle: 'com.example.ime', children: [{ type: 'Button', text: 'q' }] },
      ],
    };
    expect(flattenLayout(tree)).toEqual([
      { bundle: 'com.example.app', window: 'com.example.app' },
      { type: 'Text', text: 'a', window: 'com.example.app' },
      { bundle: 'com.example.ime', window: 'com.example.ime' },
      { type: 'Button', text: 'q', window: 'com.example.ime' },
    ]);
  });
});

describe('withoutWindow', () => {
  it('drops the windows owned by a bundle, at any depth', () => {
    const tree: LayoutNode = {
      children: [
        { bundle: 'com.example.app', children: [{ type: 'Button', text: 'Done' }] },
        { children: [{ bundle: 'com.example.ime', children: [{ type: 'Button', text: 'Done' }] }] },
      ],
    };
    const flat = flattenLayout(withoutWindow(tree, 'com.example.ime'));
    expect(flat.filter((n) => n.text === 'Done').map((n) => n.window)).toEqual(['com.example.app']);
    expect(flat.some((n) => n.bundle === 'com.example.ime')).toBe(false);
  });
});

type Box = [number, number, number, number];
function el(type: string, label: Partial<LayoutNode>, b: Box, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { type, ...label, b, c: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], ...extra };
}

describe('findLayoutNodes', () => {
  const signIn = el('Button', { text: 'Sign in' }, [0.1, 0.5, 0.9, 0.55], { click: true });
  const google = el('Button', { text: 'Sign in with Google' }, [0.1, 0.6, 0.9, 0.65], { click: true });
  const email = el('TextInput', { hint: 'you@example.com' }, [0.1, 0.3, 0.9, 0.35], { id: 'email', click: true });
  const icon = el('Image', { desc: 'Settings' }, [0.8, 0, 0.9, 0.05], { key: 'settingsBtn' });
  const tree: LayoutNode = { children: [signIn, google, email, icon] };

  it('prefers exact (case-insensitive) label matches over substring ones', () => {
    expect(findLayoutNodes(tree, { text: '  sign IN ' }).map((n) => n.text)).toEqual(['Sign in']);
    expect(findLayoutNodes(tree, { text: 'google' }).map((n) => n.text)).toEqual(['Sign in with Google']);
  });

  it('matches hint and desc labels', () => {
    expect(findLayoutNodes(tree, { text: 'you@example.com' })[0]?.id).toBe('email');
    expect(findLayoutNodes(tree, { text: 'settings' })[0]?.desc).toBe('Settings');
  });

  it('matches id or key, and filters by type case-insensitively', () => {
    expect(findLayoutNodes(tree, { id: 'email' })).toHaveLength(1);
    expect(findLayoutNodes(tree, { id: 'settingsBtn' })[0]?.desc).toBe('Settings');
    expect(findLayoutNodes(tree, { type: 'button' })).toHaveLength(2);
    expect(findLayoutNodes(tree, { text: 'sign in', type: 'textinput' })).toHaveLength(0);
  });

  it('rejects an empty selector or a blank text', () => {
    expect(() => findLayoutNodes(tree, {})).toThrow(/text, id, or type/);
    expect(() => findLayoutNodes(tree, { text: '  ' })).toThrow(/must not be blank/);
  });
});

describe('pickTarget', () => {
  const pickError = (fn: () => unknown): TargetNotFoundError => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(TargetNotFoundError);
      return err as TargetNotFoundError;
    }
    throw new Error('expected pickTarget to throw');
  };

  it('prefers a clickable match over a plain label with the same text', () => {
    const title = el('Text', { text: 'Sign in' }, [0.1, 0.1, 0.9, 0.15]);
    const button = el('Button', { text: 'Sign in' }, [0.1, 0.5, 0.9, 0.55], { click: true });
    expect(pickTarget({ children: [title, button] }, { text: 'Sign in' })).toMatchObject({ type: 'Button' });
  });

  it('collapses a clickable label nested inside a larger clickable match', () => {
    const inner = el('Text', { text: 'Save' }, [0.45, 0.5, 0.55, 0.52], { click: true });
    const outer = el('Button', { text: 'Save' }, [0.1, 0.48, 0.9, 0.54], { click: true, children: [inner] });
    expect(pickTarget({ children: [outer] }, { text: 'save' })).toMatchObject({ type: 'Button' });
  });

  it('skips covered matches, and reports when every match is covered', () => {
    const hidden = el('Button', { text: 'Home' }, [0, 0.9, 0.2, 1], { click: true, covered: true });
    const shown = el('Text', { text: 'Home' }, [0, 0, 1, 0.05]);
    expect(pickTarget({ children: [hidden, shown] }, { text: 'Home' })).toMatchObject({ type: 'Text' });
    expect(pickError(() => pickTarget({ children: [hidden] }, { text: 'Home' })).reason).toBe('covered');
  });

  it('reports no match', () => {
    const err = pickError(() => pickTarget({ children: [] }, { text: 'Nope' }));
    expect(err.reason).toBe('none');
    expect(err.message).toMatch(/dump layout --flat/);
  });

  it('lists the candidates when ambiguous, and picks one by index', () => {
    const a = el('Button', { text: 'Delete' }, [0, 0.2, 0.2, 0.25], { click: true });
    const b = el('Button', { text: 'Delete' }, [0, 0.4, 0.2, 0.45], { click: true });
    const tree: LayoutNode = { children: [a, b] };
    const err = pickError(() => pickTarget(tree, { text: 'Delete' }));
    expect(err.reason).toBe('ambiguous');
    expect(err.message).toMatch(/\[0\] Button "Delete" at 0\.100,0\.225; \[1\] Button "Delete" at 0\.100,0\.425/);
    expect(pickTarget(tree, { text: 'Delete' }, 1).c).toEqual(b.c);
    expect(pickError(() => pickTarget(tree, { text: 'Delete' }, 2)).message).toMatch(/out of range/);
  });

  it('ignores matches without a position', () => {
    const offscreen: LayoutNode = { type: 'Button', text: 'Go', click: true };
    expect(pickError(() => pickTarget({ children: [offscreen] }, { text: 'Go' })).reason).toBe('none');
  });
});
