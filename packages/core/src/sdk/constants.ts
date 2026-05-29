export interface SdkRelease {
  version: string;
  api: string;
  /**
   * Number of leading path components to strip when extracting the release
   * tarball, per OS family. The Huawei mirror packs linux+windows in one
   * tarball (no top-level wrapper for some releases → 0, else 1); macOS
   * tarballs have a deeper layout (3). This table is the single source of
   * truth read by `getSdkFilename()`.
   */
  tarballStrip: { linuxWindows: number; darwin: number };
}

/**
 * Known OpenHarmony SDK releases. Kept in sync with the bash CLI / extension.
 * Update when a new SDK ships.
 */
export const ALL_SDKS: readonly SdkRelease[] = [
  { version: '4.0', api: '10', tarballStrip: { linuxWindows: 1, darwin: 3 } },
  { version: '4.1', api: '11', tarballStrip: { linuxWindows: 1, darwin: 3 } },
  { version: '5.0.0', api: '12', tarballStrip: { linuxWindows: 0, darwin: 3 } },
  { version: '5.0.1', api: '13', tarballStrip: { linuxWindows: 0, darwin: 3 } },
  { version: '5.0.2', api: '14', tarballStrip: { linuxWindows: 1, darwin: 3 } },
  { version: '5.0.3', api: '15', tarballStrip: { linuxWindows: 1, darwin: 3 } },
  { version: '5.1.0', api: '18', tarballStrip: { linuxWindows: 1, darwin: 3 } },
  { version: '5.1.1', api: '19', tarballStrip: { linuxWindows: 1, darwin: 3 } },
  { version: '6.0', api: '20', tarballStrip: { linuxWindows: 0, darwin: 3 } },
  { version: '6.1', api: '23', tarballStrip: { linuxWindows: 0, darwin: 3 } },
];

export const OHOS_URL_BASE = 'https://repo.huaweicloud.com/openharmony/os';
