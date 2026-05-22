import { describe, expect, it } from 'vitest';
import { getCmdToolsDownloadUrl } from '../src/cmdTools/install.js';
import { staticConfig, defaultPaths } from '../src/ports/config.js';

describe('getCmdToolsDownloadUrl', () => {
  it('returns the Linux default when no override is configured', () => {
    expect(getCmdToolsDownloadUrl(staticConfig(), 'linux')).toBe(defaultPaths.cmdToolsUrlLinux);
  });

  it('throws on Windows without a configured URL (Huawei mirror has no public build)', () => {
    expect(() => getCmdToolsDownloadUrl(staticConfig(), 'win32')).toThrow(
      /No Windows command-line tools URL configured/,
    );
  });

  it('Windows error message mentions --from-zip as the supported alternative', () => {
    expect(() => getCmdToolsDownloadUrl(staticConfig(), 'win32')).toThrow(/--from-zip/);
  });

  it('throws on macOS without a configured URL', () => {
    expect(() => getCmdToolsDownloadUrl(staticConfig(), 'darwin')).toThrow(
      /No macOS command-line tools URL configured/,
    );
  });

  it('macOS error message mentions --from-zip as the supported alternative', () => {
    expect(() => getCmdToolsDownloadUrl(staticConfig(), 'darwin')).toThrow(/--from-zip/);
  });

  it('respects an explicit override on Linux', () => {
    const cfg = staticConfig({ cmdToolsUrlLinux: 'https://mirror.example.com/linux.zip' });
    expect(getCmdToolsDownloadUrl(cfg, 'linux')).toBe('https://mirror.example.com/linux.zip');
  });

  it('respects an explicit override on Windows', () => {
    const cfg = staticConfig({ cmdToolsUrlWindows: 'https://mirror.example.com/windows.zip' });
    expect(getCmdToolsDownloadUrl(cfg, 'win32')).toBe('https://mirror.example.com/windows.zip');
  });

  it('respects an explicit override on macOS', () => {
    const cfg = staticConfig({ cmdToolsUrlMac: 'https://mirror.example.com/mac.zip' });
    expect(getCmdToolsDownloadUrl(cfg, 'darwin')).toBe('https://mirror.example.com/mac.zip');
  });

  it('throws for unsupported platforms', () => {
    expect(() => getCmdToolsDownloadUrl(staticConfig(), 'aix' as NodeJS.Platform)).toThrow();
  });
});
