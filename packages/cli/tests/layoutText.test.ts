import { describe, expect, it } from 'vitest';
import type { DumpLayoutResult, LayoutNode } from '@oniroproject/core';
import { formatFlatLayout, formatLayoutLine, formatSelectorMatches } from '../src/lib/layoutText.js';

describe('formatLayoutLine', () => {
  it('prints type, labels, id, center, and flags', () => {
    expect(
      formatLayoutLine({ type: 'TextInput', hint: 'Email', id: 'email', c: [0.5, 0.25], click: true, focus: true, disabled: true }),
    ).toBe('TextInput hint="Email" #email c=0.500,0.250 click focus disabled');
    expect(formatLayoutLine({ type: 'Toggle', c: [0.9, 0.4], check: true })).toBe('Toggle c=0.900,0.400 checkable');
    expect(formatLayoutLine({ type: 'Toggle', c: [0.9, 0.4], check: true, checked: true })).toBe('Toggle c=0.900,0.400 checked');
  });

  it('JSON-quotes labels and truncates long ones', () => {
    expect(formatLayoutLine({ type: 'Text', text: 'say "hi"\nnow' })).toBe('Text "say \\"hi\\"\\nnow"');
    const line = formatLayoutLine({ type: 'Text', text: 'x'.repeat(200) });
    expect(line).toBe(`Text "${'x'.repeat(79)}…"`);
  });
});

describe('formatFlatLayout', () => {
  const app: LayoutNode = {
    bundle: 'com.example.app',
    b: [0, 0, 1, 1],
    c: [0.5, 0.5],
    children: [
      { type: 'Text', text: 'Sign in', c: [0.5, 0.1] },
      { type: 'Image', c: [0.5, 0.2] }, // decorative: not listed
      { type: 'TextInput', hint: 'Email', id: 'email', c: [0.5, 0.3], click: true, focus: true },
      { type: 'Button', text: 'Sign in', c: [0.5, 0.9], click: true, covered: true },
    ],
  };
  const keyboard: LayoutNode = {
    bundle: 'dev.patrickgold.florisboard',
    b: [0, 0.7, 1, 1],
    children: [{ type: 'Button', text: 'q', c: [0.05, 0.75], click: true }],
  };

  it('groups elements by window and collapses the soft keyboard to one line', () => {
    const result: DumpLayoutResult = {
      display: { width: 1080, height: 2400 },
      tree: { children: [app, keyboard] },
      keyboard: { shown: true, bundle: 'dev.patrickgold.florisboard', b: [0, 0.7, 1, 1] },
    };
    expect(formatFlatLayout(result).split('\n')).toEqual([
      '# display 1080x2400; c = element center as 0-1 fractions (input --fx/--fy), or act by label with input --target "<text>"',
      '[window com.example.app]',
      'Text "Sign in" c=0.500,0.100',
      'TextInput hint="Email" #email c=0.500,0.300 click focus',
      'Button "Sign in" c=0.500,0.900 click covered',
      '[keyboard dev.patrickgold.florisboard] up — dismiss with input --type hideKeyboard',
      '',
    ]);
  });

  it('lists a window normally when keyboard detection did not run', () => {
    const out = formatFlatLayout({ display: null, tree: { children: [app, keyboard] } });
    expect(out).toContain('# display unknown;');
    expect(out).toContain('[window dev.patrickgold.florisboard]\nButton "q" c=0.050,0.750 click\n');
  });

  it('puts the window id (what --window takes) in the header, one header per window', () => {
    const shade: LayoutNode = { bundle: 'com.ohos.sceneboard', windowId: 20, children: [{ type: 'Text', text: '12:42', c: [0.1, 0.02] }] };
    const bar: LayoutNode = { bundle: 'com.ohos.sceneboard', windowId: 18, children: [{ type: 'Button', text: 'Back', c: [0.5, 0.98], click: true }] };
    const out = formatFlatLayout({ display: null, tree: { children: [{ ...app, windowId: 92 }, shade, bar] } });
    expect(out).toContain('[window 92 com.example.app]\nText "Sign in"');
    expect(out).toContain('[window 20 com.ohos.sceneboard]\nText "12:42" c=0.100,0.020\n[window 18 com.ohos.sceneboard]\nButton "Back"');
  });
});

describe('formatSelectorMatches', () => {
  it('numbers the matches for the [n] suffix and names their window', () => {
    const out = formatSelectorMatches({ width: 1080, height: 2400 }, 'type=Button,text*=Sign', [
      { type: 'Button', text: 'Sign in', id: 'signIn', c: [0.361, 0.214], click: true, window: 'com.example.app', windowId: 92 },
      { type: 'Button', text: 'Sign up', id: 'signUp', c: [0.631, 0.214], click: true, window: 'com.example.app', windowId: 92 },
    ]);
    expect(out.split('\n')).toEqual([
      '# display 1080x2400; 2 element(s) match "type=Button,text*=Sign"; append [n] to the selector to act on one',
      '[0] Button "Sign in" #signIn c=0.361,0.214 click (window 92 com.example.app)',
      '[1] Button "Sign up" #signUp c=0.631,0.214 click (window 92 com.example.app)',
      '',
    ]);
    expect(formatSelectorMatches(null, 'id=x', [])).toBe('# display unknown; 0 element(s) match "id=x"\n');
  });
});
