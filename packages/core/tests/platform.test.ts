import { describe, expect, it } from 'vitest';
import { getSdkFilename } from '../src/sdk/platform.js';
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

  it('falls back to the latest known SDK when version is omitted', () => {
    const info = getSdkFilename();
    expect(info.filename).toBeTruthy();
  });
});
