import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { staticConfig, defaultPaths } from '../src/ports/config.js';
import { getSdkRootDir, getCmdToolsPath, getEmulatorDir } from '../src/sdk/paths.js';
import { OHOS_URL_BASE } from '../src/sdk/constants.js';

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

describe('sdkUrlBase / applicationCertPath config keys', () => {
  it('sdkUrlBase falls back to the Huawei mirror default', () => {
    expect(staticConfig().get('sdkUrlBase', OHOS_URL_BASE)).toBe(OHOS_URL_BASE);
  });

  it('sdkUrlBase honors an explicit mirror', () => {
    const config = staticConfig({ sdkUrlBase: 'https://mirror.example/os' });
    expect(config.get('sdkUrlBase', OHOS_URL_BASE)).toBe('https://mirror.example/os');
  });

  it('applicationCertPath is empty by default (use bundled cert)', () => {
    expect(staticConfig().get('applicationCertPath', '')).toBe('');
  });

  it('applicationCertPath honors an explicit path', () => {
    const config = staticConfig({ applicationCertPath: '/certs/app.cer' });
    expect(config.get('applicationCertPath', '')).toBe('/certs/app.cer');
  });
});
