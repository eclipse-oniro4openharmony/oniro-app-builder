import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Keys read from the ConfigProvider by core. Frontends (CLI, VS Code extension)
 * implement the provider however they like (env vars, settings.json, etc.).
 */
export type ConfigKey =
  | 'sdkRootDir'
  | 'cmdToolsPath'
  | 'emulatorDir'
  | 'hapPath'
  | 'cmdToolsUrlLinux'
  | 'cmdToolsUrlWindows'
  | 'cmdToolsUrlMac'
  | 'emulatorUrl'
  // Base URL for OpenHarmony SDK release downloads. Defaults to the Huawei mirror
  // (`OHOS_URL_BASE`); override to point at a private/CI mirror.
  | 'sdkUrlBase'
  // Optional path to an external application-cert chain that overrides the bundled
  // `OpenHarmonyApplication.cer` during signing. Empty/unset → use the bundled cert.
  | 'applicationCertPath';

export interface ConfigProvider {
  /**
   * Get the configured value for `key`, or `fallback` if unset/empty.
   * Implementations should expand the literal `${userHome}` to the user's home dir.
   */
  get<T extends string | number | boolean>(key: ConfigKey, fallback: T): T;
}

/**
 * Default config values used when a ConfigProvider returns the fallback.
 * These match the historical paths used by the bash CLI and the extension.
 */
export const defaultPaths = {
  sdkRootDir: () => path.join(os.homedir(), 'setup-ohos-sdk'),
  cmdToolsPath: () => path.join(os.homedir(), 'command-line-tools'),
  emulatorDir: () => path.join(os.homedir(), 'oniro-emulator'),
  hapPath: 'entry/build/default/outputs/default/entry-default-signed.hap',
  emulatorUrl:
    'https://github.com/eclipse-oniro4openharmony/device_board_oniro/releases/latest/download/oniro_emulator.zip',
  // The Huawei mirror only hosts a public Linux build of the command-line tools.
  // Windows and macOS require a manual download from the Huawei developer portal
  // (https://developer.huawei.com/...); pass the resulting ZIP to `cmdtools install --from-zip <path>`
  // or set ONIRO_CMD_TOOLS_URL_WINDOWS / ONIRO_CMD_TOOLS_URL_MAC to a self-hosted URL.
  cmdToolsUrlLinux:
    'https://repo.huaweicloud.com/harmonyos/ohpm/5.1.0/commandline-tools-linux-x64-5.1.0.840.zip',
} as const;

/**
 * A simple in-memory ConfigProvider, useful for tests and as a base for CLI/extension impls.
 */
export function staticConfig(values: Partial<Record<ConfigKey, string>> = {}): ConfigProvider {
  return {
    get<T extends string | number | boolean>(key: ConfigKey, fallback: T): T {
      const v = values[key];
      if (v === undefined || v === '') {
        return fallback;
      }
      // Expand ${userHome} like the extension does.
      if (typeof v === 'string' && v.includes('${userHome}')) {
        return v.replace(/\$\{userHome\}/g, os.homedir()) as unknown as T;
      }
      return v as unknown as T;
    },
  };
}
