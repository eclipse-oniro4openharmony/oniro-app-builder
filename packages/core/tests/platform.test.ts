import { describe, expect, it } from 'vitest';
import { getSdkFilename } from '../src/sdk/platform.js';
import { ALL_SDKS } from '../src/sdk/constants.js';
import * as os from 'node:os';

describe('getSdkFilename', () => {
  it('returns the right archive info for the current platform', () => {
    const info = getSdkFilename('5.1.0');
    if (os.platform() === 'linux') {
      expect(info).toEqual({
        filename: 'ohos-sdk-windows_linux-public.tar.gz',
        osFolder: 'linux',
        strip: 1,
      });
    } else if (os.platform() === 'darwin') {
      expect(info.osFolder).toBe('darwin');
      expect(info.strip).toBe(3);
    } else if (os.platform() === 'win32') {
      expect(info.osFolder).toBe('windows');
      expect(info.filename).toBe('ohos-sdk-windows_linux-public.tar.gz');
    }
  });

  it('strips zero components for 6.1/6.0/5.0.0/5.0.1 on linux/windows', () => {
    if (os.platform() !== 'darwin') {
      expect(getSdkFilename('6.1').strip).toBe(0);
      expect(getSdkFilename('6.0').strip).toBe(0);
      expect(getSdkFilename('5.0.0').strip).toBe(0);
      expect(getSdkFilename('5.0.1').strip).toBe(0);
    }
  });

  it('strips one component for 5.1.1 (API 19) on linux/windows, three on darwin', () => {
    expect(getSdkFilename('5.1.1').strip).toBe(os.platform() === 'darwin' ? 3 : 1);
  });

  it('reads the strip count from the ALL_SDKS table for every release', () => {
    for (const r of ALL_SDKS) {
      const expected = os.platform() === 'darwin' ? r.tarballStrip.darwin : r.tarballStrip.linuxWindows;
      expect(getSdkFilename(r.version).strip).toBe(expected);
    }
  });

  it('falls back to the historical default (1 / 3) for an unrecognized version', () => {
    expect(getSdkFilename('99.99').strip).toBe(os.platform() === 'darwin' ? 3 : 1);
  });

  it('falls back to the latest known SDK when version is omitted', () => {
    const info = getSdkFilename();
    expect(info.filename).toBeTruthy();
  });
});

describe('ALL_SDKS catalog', () => {
  it('includes API 19 (5.1.1) between 5.1.0 and 6.0', () => {
    const versions = ALL_SDKS.map((r) => r.version);
    expect(versions).toContain('5.1.1');
    const i = versions.indexOf('5.1.1');
    expect(ALL_SDKS[i]!.api).toBe('19');
    expect(versions[i - 1]).toBe('5.1.0');
    expect(versions[i + 1]).toBe('6.0');
  });

  it('gives every release a per-OS tarballStrip', () => {
    for (const r of ALL_SDKS) {
      expect(typeof r.tarballStrip.linuxWindows).toBe('number');
      expect(typeof r.tarballStrip.darwin).toBe('number');
    }
  });
});
