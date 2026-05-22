export interface SdkRelease {
  version: string;
  api: string;
}

/**
 * Known OpenHarmony SDK releases. Kept in sync with the bash CLI / extension.
 * Update when a new SDK ships.
 */
export const ALL_SDKS: readonly SdkRelease[] = [
  { version: '4.0', api: '10' },
  { version: '4.1', api: '11' },
  { version: '5.0.0', api: '12' },
  { version: '5.0.1', api: '13' },
  { version: '5.0.2', api: '14' },
  { version: '5.0.3', api: '15' },
  { version: '5.1.0', api: '18' },
  { version: '6.0', api: '20' },
  { version: '6.1', api: '23' },
];

export const OHOS_URL_BASE = 'https://repo.huaweicloud.com/openharmony/os';
