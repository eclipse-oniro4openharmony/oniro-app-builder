import { describe, expect, it } from 'vitest';
import { decideInstallMethod, decideReboot } from '../src/install/apply.js';
import { diffEntryNames } from '../src/install/diffHapAssets.js';

describe('decideInstallMethod', () => {
  it('replaces when sign info is consistent', () => {
    expect(decideInstallMethod({ signInfoInconsistent: false, isSystemBundle: true, allowUninstall: false })).toBe('replace');
    expect(decideInstallMethod({ signInfoInconsistent: false, isSystemBundle: false, allowUninstall: false })).toBe('replace');
  });

  it('refuses a system bundle on sign-info mismatch unless allowUninstall', () => {
    expect(decideInstallMethod({ signInfoInconsistent: true, isSystemBundle: true, allowUninstall: false })).toBe('refuse');
    expect(decideInstallMethod({ signInfoInconsistent: true, isSystemBundle: true, allowUninstall: true })).toBe('uninstall-install');
  });

  it('uninstall-installs a normal app on sign-info mismatch', () => {
    expect(decideInstallMethod({ signInfoInconsistent: true, isSystemBundle: false, allowUninstall: false })).toBe('uninstall-install');
  });
});

describe('decideReboot', () => {
  it('reboots for an asset-path change regardless of pids', () => {
    expect(decideReboot({ assetsChanged: true, isSystemBundle: false, preInstallPid: 5, postInstallPid: 9 })).toEqual({
      reboot: true,
      reason: 'asset-cache',
    });
  });

  it('reboots a system bundle whose process did not restart', () => {
    expect(decideReboot({ assetsChanged: false, isSystemBundle: true, preInstallPid: 111, postInstallPid: 111 })).toEqual({
      reboot: true,
      reason: 'pid-unchanged',
    });
  });

  it('does not reboot when the system bundle restarted (pid changed)', () => {
    expect(decideReboot({ assetsChanged: false, isSystemBundle: true, preInstallPid: 111, postInstallPid: 222 })).toEqual({
      reboot: false,
      reason: 'none',
    });
  });

  it('does not reboot when the bundle was not running before', () => {
    expect(decideReboot({ assetsChanged: false, isSystemBundle: true, preInstallPid: null, postInstallPid: 222 })).toEqual({
      reboot: false,
      reason: 'none',
    });
  });

  it('does not reboot a normal app on an unchanged pid', () => {
    expect(decideReboot({ assetsChanged: false, isSystemBundle: false, preInstallPid: 111, postInstallPid: 111 })).toEqual({
      reboot: false,
      reason: 'none',
    });
  });
});

describe('diffEntryNames', () => {
  it('computes sorted added/removed sets', () => {
    expect(diffEntryNames(['a.txt', 'res/x.png', 'common'], ['common', 'res/y.png', 'a.txt'])).toEqual({
      addedAssetPaths: ['res/y.png'],
      removedAssetPaths: ['res/x.png'],
    });
  });

  it('is empty when manifests match', () => {
    expect(diffEntryNames(['a', 'b'], ['b', 'a'])).toEqual({ addedAssetPaths: [], removedAssetPaths: [] });
  });
});
