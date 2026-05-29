import * as os from 'node:os';
import { ALL_SDKS } from './constants.js';
import { UnsupportedPlatformError } from '../ports/errors.js';

export type OsFolder = 'linux' | 'darwin' | 'windows';

/**
 * Map Node's `os.platform()` to the OS folder name used in the SDK install layout
 * and the SDK release tarballs.
 */
export function getOsFolder(): OsFolder {
  const platform = os.platform();
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'windows';
  throw new UnsupportedPlatformError(platform);
}

export interface SdkArchiveInfo {
  filename: string;
  osFolder: OsFolder;
  /** Number of leading path components to strip when extracting the tarball. */
  strip: number;
}

/**
 * Resolve the SDK archive filename, OS folder, and tar strip count for the current platform.
 *
 * The Huawei mirror packages Linux and Windows together in one tarball with `linux/` and
 * `windows/` subfolders; macOS tarballs have a deeper layout. The per-release strip counts
 * live in {@link ALL_SDKS} (`tarballStrip`). An unrecognized version falls back to the
 * historical default (linux/windows=1, darwin=3).
 */
export function getSdkFilename(version?: string): SdkArchiveInfo {
  const platform = os.platform();
  const v = version ?? ALL_SDKS[ALL_SDKS.length - 1]!.version;
  const strips = ALL_SDKS.find((r) => r.version === v)?.tarballStrip ?? { linuxWindows: 1, darwin: 3 };

  if (platform === 'linux') {
    return { filename: 'ohos-sdk-windows_linux-public.tar.gz', osFolder: 'linux', strip: strips.linuxWindows };
  }
  if (platform === 'darwin') {
    if (os.arch() === 'arm64') {
      return { filename: 'L2-SDK-MAC-M1-PUBLIC.tar.gz', osFolder: 'darwin', strip: strips.darwin };
    }
    return { filename: 'ohos-sdk-mac-public.tar.gz', osFolder: 'darwin', strip: strips.darwin };
  }
  if (platform === 'win32') {
    return { filename: 'ohos-sdk-windows_linux-public.tar.gz', osFolder: 'windows', strip: strips.linuxWindows };
  }
  throw new UnsupportedPlatformError(platform);
}
