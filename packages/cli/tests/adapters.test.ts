import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { createEnvConfig } from '../src/adapters/config.js';
import { createCliLogger } from '../src/adapters/logger.js';
import { createCliProgress } from '../src/adapters/progress.js';

describe('createEnvConfig', () => {
  it('returns the fallback when the env var is unset', () => {
    const cfg = createEnvConfig({});
    expect(cfg.get('sdkRootDir', '/default')).toBe('/default');
  });

  it('returns the configured env var value', () => {
    const cfg = createEnvConfig({ ONIRO_SDK_ROOT_DIR: '/opt/ohos' });
    expect(cfg.get('sdkRootDir', '/default')).toBe('/opt/ohos');
  });

  it('expands ${userHome}', () => {
    const cfg = createEnvConfig({ ONIRO_EMULATOR_DIR: '${userHome}/oniro' });
    expect(cfg.get('emulatorDir', '/default')).toBe(`${os.homedir()}/oniro`);
  });

  it('treats empty env var as unset', () => {
    const cfg = createEnvConfig({ ONIRO_CMD_TOOLS_PATH: '' });
    expect(cfg.get('cmdToolsPath', '/default')).toBe('/default');
  });
});

describe('createCliLogger', () => {
  it('produces a Logger with all 4 methods', () => {
    const log = createCliLogger();
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });
});

describe('createCliProgress', () => {
  it('produces a ProgressReporter', () => {
    const p = createCliProgress();
    expect(typeof p.report).toBe('function');
    // Reports don't throw.
    expect(() => p.report({ message: 'hello', increment: 10 })).not.toThrow();
  });
});
