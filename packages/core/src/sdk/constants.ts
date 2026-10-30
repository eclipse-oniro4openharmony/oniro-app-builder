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
  /**
   * Appended to the archive basename when the mirror re-published a release under a
   * dated name (e.g. 7.0 ships `ohos-sdk-windows_linux-public_20260829.tar.gz`, whose
   * components are the `-Release` build; the undated archive holds `-Beta` ones).
   */
  archiveSuffix?: string;
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
  { version: '7.0', api: '26', tarballStrip: { linuxWindows: 1, darwin: 3 }, archiveSuffix: '_20260829' },
];

export const OHOS_URL_BASE = 'https://repo.huaweicloud.com/openharmony/os';

/**
 * OpenHarmony daily builds. The full SDK (with `@systemapi` declarations) is not on the
 * release mirror; its `ohos-sdk-full` archives are published here, to be installed with
 * `installSdkFromArchive`.
 */
export const OHOS_DAILY_BUILDS_URL = 'https://dcp.openharmony.cn/workbench/cicd/dailybuild/dailylist';
