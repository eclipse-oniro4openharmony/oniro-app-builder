import { describe, expect, it } from 'vitest';
import { detectAaStartFailure, parseMainAbilityFromBmDump } from '../src/hdc/app.js';

describe('detectAaStartFailure', () => {
  it('flags the locked-screen refusal (aa start exits 0 but prints this)', () => {
    const out =
      'error: failed to start ability.\n' +
      'Error Code:10106102  Error Message:The device screen is locked during the application launch, unlock screen failed.';
    expect(detectAaStartFailure(out)).toMatch(/10106102/);
  });

  it('flags a bare error code / message', () => {
    expect(detectAaStartFailure('Error Code:401 Error Message:permission denied')).toBeTruthy();
  });

  it('flags a "failed to start ability" line on its own', () => {
    expect(detectAaStartFailure('error: failed to start ability.')).toBeTruthy();
  });

  it('returns null on a successful launch', () => {
    expect(detectAaStartFailure('start ability successfully.')).toBeNull();
  });

  it('returns null on empty output', () => {
    expect(detectAaStartFailure('')).toBeNull();
    expect(detectAaStartFailure('\n')).toBeNull();
  });
});

describe('parseMainAbilityFromBmDump', () => {
  const dump = (mods: unknown[]): string =>
    `com.ohos.note:\n${JSON.stringify({ name: 'com.ohos.note', hapModuleInfos: mods })}`;

  it('parses the main ability past the bundle-name prefix line', () => {
    expect(parseMainAbilityFromBmDump(dump([{ moduleName: 'default', mainElementName: 'MainAbility', moduleType: 1 }]))).toBe(
      'MainAbility',
    );
  });

  it('prefers the entry module (moduleType 1) over a non-entry module', () => {
    const out = dump([
      { moduleName: 'feature', mainElementName: 'FeatureAbility', moduleType: 2 },
      { moduleName: 'entry', mainElementName: 'EntryAbility', moduleType: 1 },
    ]);
    expect(parseMainAbilityFromBmDump(out)).toBe('EntryAbility');
  });

  it('falls back to mainAbility when mainElementName is absent', () => {
    expect(parseMainAbilityFromBmDump(dump([{ moduleName: 'default', mainAbility: 'MainAbility' }]))).toBe('MainAbility');
  });

  it('returns null when no module declares a main ability or the output is unparseable', () => {
    expect(parseMainAbilityFromBmDump(dump([{ moduleName: 'default' }]))).toBeNull();
    expect(parseMainAbilityFromBmDump('error: bundle not found')).toBeNull();
    expect(parseMainAbilityFromBmDump('')).toBeNull();
  });
});
