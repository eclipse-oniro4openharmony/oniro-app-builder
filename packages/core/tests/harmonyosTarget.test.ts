import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectRuntimeOs, harmonyOsSdkLabelForApi } from '../src/harmonyos/target.js';

describe('detectRuntimeOs', () => {
  let dir: string;
  const profile = (products: unknown) =>
    fs.writeFileSync(path.join(dir, 'build-profile.json5'), JSON.stringify({ app: { products } }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-target-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is HarmonyOS only when runtimeOS says so', () => {
    profile([{ name: 'default', runtimeOS: 'HarmonyOS', compileSdkVersion: '5.0.5(17)' }]);
    expect(detectRuntimeOs(dir)).toBe('HarmonyOS');
  });

  it('keeps every other project OpenHarmony', () => {
    // An OpenHarmony project must never be routed to the HarmonyOS SDK, whatever
    // else its profile looks like — including a HarmonyOS-style version label.
    profile([{ name: 'default', runtimeOS: 'OpenHarmony', compileSdkVersion: '5.0.5(17)' }]);
    expect(detectRuntimeOs(dir)).toBe('OpenHarmony');
    profile([{ name: 'default', compatibleSdkVersion: '5.0.5(17)' }]);
    expect(detectRuntimeOs(dir)).toBe('OpenHarmony');
    profile([{ name: 'default', compileSdkVersion: 20 }]);
    expect(detectRuntimeOs(dir)).toBe('OpenHarmony');
    profile([]);
    expect(detectRuntimeOs(dir)).toBe('OpenHarmony');
  });

  it('treats a missing or malformed profile as OpenHarmony', () => {
    expect(detectRuntimeOs(dir)).toBe('OpenHarmony');
    fs.writeFileSync(path.join(dir, 'build-profile.json5'), '{ not json5');
    expect(detectRuntimeOs(dir)).toBe('OpenHarmony');
  });

  it('reads the named product, else the first', () => {
    profile([
      { name: 'oh', runtimeOS: 'OpenHarmony' },
      { name: 'hos', runtimeOS: 'HarmonyOS' },
    ]);
    expect(detectRuntimeOs(dir, 'hos')).toBe('HarmonyOS');
    expect(detectRuntimeOs(dir, 'absent')).toBe('OpenHarmony');
    expect(detectRuntimeOs(dir)).toBe('OpenHarmony');
  });
});

describe('harmonyOsSdkLabelForApi', () => {
  it('renders the "<version>(<api>)" label DevEco writes', () => {
    expect(harmonyOsSdkLabelForApi(17)).toBe('5.0.5(17)');
    expect(harmonyOsSdkLabelForApi(21)).toBe('6.0.1(21)');
  });

  it('knows nothing of API levels without a HarmonyOS release', () => {
    expect(harmonyOsSdkLabelForApi(9)).toBeUndefined();
  });
});
