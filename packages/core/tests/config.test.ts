import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { staticConfig, defaultPaths } from '../src/ports/config.js';
import { getSdkRootDir, getCmdToolsPath, getEmulatorDir } from '../src/sdk/paths.js';

describe('staticConfig', () => {
  it('returns the fallback when no value is configured', () => {
    const config = staticConfig();
    expect(getSdkRootDir(config)).toBe(defaultPaths.sdkRootDir());
    expect(getCmdToolsPath(config)).toBe(defaultPaths.cmdToolsPath());
    expect(getEmulatorDir(config)).toBe(defaultPaths.emulatorDir());
  });

  it('expands ${userHome} in configured values', () => {
    const config = staticConfig({ sdkRootDir: '${userHome}/my-sdks' });
    expect(getSdkRootDir(config)).toBe(`${os.homedir()}/my-sdks`);
  });

  it('respects an explicit configured value', () => {
    const config = staticConfig({ emulatorDir: '/opt/oniro/emulator' });
    expect(getEmulatorDir(config)).toBe('/opt/oniro/emulator');
  });
});
