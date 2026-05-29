import * as os from 'node:os';
import type { ConfigKey, ConfigProvider } from '@oniroproject/core';

/**
 * Maps a core ConfigKey to its environment variable name.
 * Convention: ONIRO_<UPPER_SNAKE>.
 */
const ENV_VAR_BY_KEY: Record<ConfigKey, string> = {
  sdkRootDir: 'ONIRO_SDK_ROOT_DIR',
  cmdToolsPath: 'ONIRO_CMD_TOOLS_PATH',
  emulatorDir: 'ONIRO_EMULATOR_DIR',
  hapPath: 'ONIRO_HAP_PATH',
  cmdToolsUrlLinux: 'ONIRO_CMD_TOOLS_URL_LINUX',
  cmdToolsUrlWindows: 'ONIRO_CMD_TOOLS_URL_WINDOWS',
  cmdToolsUrlMac: 'ONIRO_CMD_TOOLS_URL_MAC',
  emulatorUrl: 'ONIRO_EMULATOR_URL',
  sdkUrlBase: 'ONIRO_SDK_URL_BASE',
  applicationCertPath: 'ONIRO_APPLICATION_CERT_PATH',
};

/**
 * Reads configuration from environment variables (ONIRO_*). Returns the fallback
 * when the variable is unset or empty. Expands `${userHome}` to the user's home
 * directory for parity with the VS Code extension's `${userHome}` expansion.
 */
export function createEnvConfig(env: NodeJS.ProcessEnv = process.env): ConfigProvider {
  return {
    get<T extends string | number | boolean>(key: ConfigKey, fallback: T): T {
      const envName = ENV_VAR_BY_KEY[key];
      const raw = env[envName];
      if (raw === undefined || raw === '') return fallback;
      const expanded = raw.includes('${userHome}')
        ? raw.replace(/\$\{userHome\}/g, os.homedir())
        : raw;
      return expanded as unknown as T;
    },
  };
}
