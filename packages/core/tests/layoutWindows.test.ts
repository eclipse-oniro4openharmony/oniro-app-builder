import { describe, expect, it } from 'vitest';
import {
  TargetNotFoundError,
  findVisibleMatch,
  flattenLayout,
  listLayoutWindows,
  parseSelector,
  parseWindowList,
  pickTarget,
  pruneLayout,
  rawWindowSubtree,
  selectableTree,
  windowNotFoundError,
  windowSubtree,
  type LayoutNode,
  type RawLayoutNode,
} from '../src/hdc/index.js';
import { layoutFixture, rawLayoutFixture, textFixture } from './_helpers/layoutFixture.js';

const tree = layoutFixture('selprobe');

describe('pruneLayout window ids', () => {
  it('marks the node where uitest’s hostWindowId changes', () => {
    expect(listLayoutWindows(tree)).toEqual([
      { windowId: 92, bundle: 'com.example.selprobe', b: [0, 0.049, 1, 1] },
      { windowId: 20, bundle: 'com.ohos.sceneboard', b: [0, 0, 1, 0.049] },
    ]);
    // Only window roots carry the id; flattening hands it down.
    const flat = flattenLayout(tree);
    expect(flat.filter((n) => 'windowId' in n && n.bundle !== undefined).length).toBe(2);
    expect(flat.find((n) => n.id === 'signIn')).toMatchObject({ windowId: 92, window: 'com.example.selprobe' });
  });

  it('keeps a window boundary even on a node with no other signal', () => {
    const raw: RawLayoutNode = {
      attributes: { hostWindowId: '' },
      children: [{ attributes: { type: 'Stack', hostWindowId: '7' }, children: [{ attributes: { type: 'Text', text: 'x', hostWindowId: '7' } }] }],
    };
    const pruned = pruneLayout(raw, null) as LayoutNode;
    expect(pruned).toEqual({ type: 'Stack', windowId: 7, children: [{ type: 'Text', text: 'x' }] });
  });

  it('marks hidden components and keeps the type of a structural node kept for its id', () => {
    const raw: RawLayoutNode = {
      attributes: { type: 'Column', id: 'list' },
      children: [{ attributes: { type: 'Text', text: 'gone', visible: 'false' } }],
    };
    expect(pruneLayout(raw, null)).toEqual({ type: 'Column', id: 'list', children: [{ type: 'Text', text: 'gone', hidden: true }] });
  });
});

describe('windowSubtree', () => {
  it('keeps one window under an empty root', () => {
    const sub = windowSubtree(tree, 20)!;
    expect(sub.children).toHaveLength(1);
    expect(flattenLayout(sub).every((n) => n.windowId === 20)).toBe(true);
    expect(windowSubtree(tree, 999)).toBeNull();
  });

  it('leaves out windows nested inside the one asked for', () => {
    const t: LayoutNode = {
      children: [{ windowId: 1, type: 'root', children: [{ type: 'Text', text: 'a' }, { windowId: 2, type: 'Dialog', children: [{ type: 'Text', text: 'b' }] }] }],
    };
    expect(flattenLayout(windowSubtree(t, 1)!).map((n) => n.text ?? n.type)).toEqual(['root', 'a']);
    expect(flattenLayout(windowSubtree(t, 2)!).map((n) => n.text ?? n.type)).toEqual(['Dialog', 'b']);
  });

  it('works on the raw tree too', () => {
    const { tree: raw } = rawLayoutFixture('selprobe');
    const sub = rawWindowSubtree(raw, 92)!;
    expect(sub.children).toHaveLength(1);
    expect(sub.children![0]!.attributes!.bundleName).toBe('com.example.selprobe');
    expect(rawWindowSubtree(raw, 999)).toBeNull();
  });
});

describe('windowNotFoundError', () => {
  it('lists the windows that are on screen', () => {
    expect(windowNotFoundError(listLayoutWindows(tree), 5).message).toMatch(
      /Window 5 is not on screen\. Windows in the layout: 92 \(com\.example\.selprobe\), 20 \(com\.ohos\.sceneboard\)\. `oniro-app dump windows`/,
    );
    expect(windowNotFoundError([], 5).message).toMatch(/does not tag nodes with their window/);
  });
});

describe('parseWindowList', () => {
  const windows = parseWindowList(textFixture('wms-windows.txt'));

  it('reads both the shown and the hidden sections', () => {
    expect(windows.length).toBe(21);
    expect(windows[0]).toEqual({
      id: 5,
      name: 'SCBScenePanel1',
      displayId: 0,
      pid: 4491,
      type: 2109,
      zOrder: 100,
      rect: [0, 0, 1080, 2400],
      focused: false,
    });
    expect(windows.find((w) => w.name === 'selprobe0')).toMatchObject({ id: 92, type: 1, zOrder: -1 });
  });

  it('flags the focus window', () => {
    expect(windows.filter((w) => w.focused).map((w) => w.name)).toEqual(['SCBScreenLock10']);
  });

  it('is empty without the table', () => {
    expect(parseWindowList('no windows here')).toEqual([]);
  });
});

describe('pickTarget / findVisibleMatch with --selector expressions', () => {
  const pickError = (fn: () => unknown): TargetNotFoundError => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(TargetNotFoundError);
      return err as TargetNotFoundError;
    }
    throw new Error('expected pickTarget to throw');
  };

  it('picks the single match of a DSL or XPath selector', () => {
    expect(pickTarget(tree, parseSelector('id=signIn')).text).toBe('Sign in');
    expect(pickTarget(tree, parseSelector('xpath=//Button[@text="Show banner"]')).id).toBe('toggle');
  });

  it('reports ambiguity with the [n] hint, and [n] picks from all matches', () => {
    const err = pickError(() => pickTarget(tree, parseSelector('type=Button,text*=Sign')));
    expect(err.reason).toBe('ambiguous');
    expect(err.message).toMatch(/append \[n\]/);
    expect(pickTarget(tree, parseSelector('type=Button,text*=Sign[1]')).id).toBe('signUp');
    expect(pickTarget(tree, parseSelector('type=Button,text*=Sign[-1]')).id).toBe('signUp');
    expect(pickTarget(tree, parseSelector('type=Button[last]')).id).toBe('disabledBtn');
    expect(pickError(() => pickTarget(tree, parseSelector('type=Button,text*=Sign[2]'))).message).toMatch(/out of range: 2 element/);
    expect(pickError(() => pickTarget(tree, parseSelector('text=Nope[0]'))).reason).toBe('none');
  });

  it('collapses a label nested in a clickable match, as --target does', () => {
    const t: LayoutNode = {
      children: [
        { type: 'Button', text: 'Save', b: [0.1, 0.4, 0.9, 0.6], c: [0.5, 0.5], click: true, children: [{ type: 'Text', text: 'Save', b: [0.4, 0.45, 0.6, 0.55], c: [0.5, 0.5] }] },
      ],
    };
    expect(pickTarget(t, parseSelector('text=Save')).type).toBe('Button');
  });

  it('refuses an indexed match that is covered', () => {
    const t: LayoutNode = { children: [{ type: 'Button', text: 'Go', c: [0.5, 0.5], click: true, covered: true }] };
    expect(pickError(() => pickTarget(t, parseSelector('text=Go[0]'))).reason).toBe('covered');
    expect(findVisibleMatch(t, parseSelector('text=Go[0]'))).toBeNull();
    expect(findVisibleMatch(t, parseSelector('text=Go'))).toBeNull();
  });

  it('findVisibleMatch honours the index', () => {
    expect(findVisibleMatch(tree, parseSelector('text^=Item[2]'))?.id).toBe('itemC');
    expect(findVisibleMatch(tree, parseSelector('text^=Item[3]'))).toBeNull();
    expect(findVisibleMatch(tree, parseSelector('text^=Item'))?.id).toBe('itemA');
  });
});

describe('selectableTree', () => {
  const kb: LayoutNode = { bundle: 'com.example.ime', windowId: 30, children: [{ type: 'Button', text: 'Done', c: [0.9, 0.9], click: true }] };
  const app: LayoutNode = { bundle: 'com.example.app', windowId: 10, children: [{ type: 'Button', text: 'Done', c: [0.5, 0.5], click: true }] };
  const layout = { display: null, tree: { children: [app, kb] }, keyboard: { shown: true, bundle: 'com.example.ime' } };

  it('drops the keyboard window unless a window was asked for', () => {
    expect(flattenLayout(selectableTree(layout)).filter((n) => n.text === 'Done').map((n) => n.windowId)).toEqual([10]);
    expect(flattenLayout(selectableTree({ ...layout, tree: windowSubtree(layout.tree, 30)! }, 30)).filter((n) => n.text === 'Done')).toHaveLength(1);
  });
});
