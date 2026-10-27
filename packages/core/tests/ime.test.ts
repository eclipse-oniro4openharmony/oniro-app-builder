import { describe, expect, it } from 'vitest';
import { parseImeBundles, findKeyboardWindow } from '../src/hdc/ime.js';
import type { LayoutNode } from '../src/hdc/dump.js';

// Trimmed `hidumper -s 3703 -a '-a'` output from a device with two IMEs installed.
const HIDUMPER = `
-------------------------------[ability]-------------------------------
----------------------------------InputMethodService----------------------------------
{"imeList":[{"ime": "com.example.kikakeyboard/ServiceExtAbility","labelId": "16777216","descriptionId": "16777217","isCurrentIme": "false","label": "kikaInput","description": "soft input extension by kika"},{"ime": "dev.patrickgold.florisboard/InputMethodService","labelId": "16777221","descriptionId": "0","isCurrentIme": "true","label": "FlorisBoard","description": "FlorisBoard — open-source keyboard"}]}
`;

describe('parseImeBundles', () => {
  it('lists IME bundles with the current one first', () => {
    expect(parseImeBundles(HIDUMPER)).toEqual(['dev.patrickgold.florisboard', 'com.example.kikakeyboard']);
  });

  it('returns an empty list when there is nothing to parse', () => {
    expect(parseImeBundles('')).toEqual([]);
    expect(parseImeBundles('hidumper: no such ability')).toEqual([]);
  });
});

describe('findKeyboardWindow', () => {
  const app: LayoutNode = { bundle: 'com.example.app', children: [{ type: 'TextInput', hint: 'Email' }] };
  const kbd: LayoutNode = { bundle: 'dev.patrickgold.florisboard', b: [0, 0.7, 1, 1], children: [{ type: 'Button', text: 'q' }] };

  it('finds the window whose bundle is a known IME', () => {
    expect(findKeyboardWindow({ children: [app, kbd] }, ['dev.patrickgold.florisboard'])).toBe(kbd);
    expect(findKeyboardWindow({ children: [app] }, ['dev.patrickgold.florisboard'])).toBeNull();
  });

  it('falls back to a bundle-name heuristic when no IMEs are known', () => {
    const ime: LayoutNode = { bundle: 'com.huawei.ohos.inputmethod' };
    expect(findKeyboardWindow({ children: [app, ime] }, [])).toBe(ime);
    expect(findKeyboardWindow({ children: [app, kbd] }, [])).toBeNull();
  });
});
