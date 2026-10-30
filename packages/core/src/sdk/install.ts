import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { ProgressReporter } from '../ports/progress.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { OHOS_URL_BASE } from './constants.js';
import { getOsFolder, getSdkFilename, type OsFolder } from './platform.js';
import { getSdkRootDir } from './paths.js';
import { downloadFile, verifySha256 } from './download.js';
import { extractTarball, extractZipWithProgress, readZipEntry } from './extract.js';
import { movePath } from './move.js';
import { createInstallTempDir, removeTempWorkDir, toSpaceError } from './tmp.js';

export interface InstallSdkOptions {
  config: ConfigProvider;
  version: string;
  api: string;
  progress?: ProgressReporter;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /**
   * Scratch directory for the download/extract temporaries. Overrides the `tmpDir`
   * config key and the default location next to the install target.
   */
  tmpDir?: string;
}

/**
 * Download and install an OpenHarmony SDK release into `<sdkRootDir>/<osFolder>/<api>`.
 *
 * Progress budget (overall 0..100):
 *   0..35  SDK archive download
 *   35..45 Checksum download
 *   45..50 Checksum verify
 *   50..60 Tarball extract
 *   60..95 Component ZIP extracts
 *   95..100 Finalize + cleanup
 */
export async function downloadAndInstallSdk(opts: InstallSdkOptions): Promise<void> {
  const { config, version, api, progress, abortSignal } = opts;
  const logger = opts.logger ?? noopLogger;

  const { filename, osFolder, strip } = getSdkFilename(version);
  const urlBase = config.get('sdkUrlBase', OHOS_URL_BASE);
  const downloadUrl = `${urlBase}/${version}-Release/${filename}`;
  const sha256Url = `${downloadUrl}.sha256`;

  const what = `the SDK ${version} install`;
  const sdkRoot = getSdkRootDir(config);
  const { dir: tmpDir, root: tmpRoot } = createInstallTempDir({
    config,
    override: opts.tmpDir,
    installRoot: sdkRoot,
    prefix: 'oniro-sdk-',
    logger,
  });
  const tarPath = path.join(tmpDir, filename);
  const sha256Path = path.join(tmpDir, `${filename}.sha256`);
  const extractDir = path.join(tmpDir, 'extract');
  fs.mkdirSync(extractDir);

  const sdkInstallDir = path.join(sdkRoot, osFolder, api);
  fs.mkdirSync(path.dirname(sdkInstallDir), { recursive: true });

  const checkCancelled = () => {
    if (abortSignal?.aborted) throw new CancelledError();
  };

  try {
    progress?.report({ message: 'Downloading SDK archive...', increment: 0 });
    await downloadFile({ url: downloadUrl, dest: tarPath, progress, abortSignal, start: 0, range: 35, what, tmpRoot });

    progress?.report({ message: 'Downloading checksum...', increment: 0 });
    await downloadFile({ url: sha256Url, dest: sha256Path, progress, abortSignal, start: 35, range: 10, what, tmpRoot });

    progress?.report({ message: 'Verifying checksum...', increment: 0 });
    await verifySha256(tarPath, sha256Path);
    progress?.report({ message: 'Verifying checksum...', increment: 5 });

    checkCancelled();

    progress?.report({ message: 'Extracting SDK (this may take a while)...', increment: 0 });
    await extractTarball(tarPath, extractDir, strip);
    progress?.report({ message: 'Extracting SDK (this may take a while)...', increment: 10 });

    checkCancelled();

    const osContentPath = path.join(extractDir, osFolder);
    if (!fs.existsSync(osContentPath)) {
      throw new OniroError(
        `Expected folder '${osFolder}' not found in extracted SDK. Tarball layout may have changed.`,
      );
    }
    await installComponents({ osContentPath, sdkInstallDir, progress, logger, start: 60, range: 35, checkCancelled });

    progress?.report({ message: 'Cleaning up...', increment: 0 });
    removeTempWorkDir(tmpDir, tmpRoot);
    progress?.report({ message: 'Cleaning up...', increment: 2 });
  } catch (err) {
    const wrapped = toSpaceError(err, tmpRoot, what);
    logger.error(`SDK install failed: ${wrapped instanceof Error ? wrapped.message : String(wrapped)}`);
    removeTempWorkDir(tmpDir, tmpRoot);
    throw wrapped;
  }
}

interface InstallComponentsOptions {
  /** Folder holding the SDK's component ZIPs; each is unpacked in place, then deleted. */
  osContentPath: string;
  /** Replaced by `osContentPath` once every component is unpacked. */
  sdkInstallDir: string;
  progress?: ProgressReporter;
  logger: Logger;
  /** Overall progress the component extracts consume; finalizing adds 3 more. */
  start: number;
  range: number;
  checkCancelled: () => void;
}

async function installComponents(opts: InstallComponentsOptions): Promise<void> {
  const { osContentPath, sdkInstallDir, progress, logger, checkCancelled } = opts;
  const zipFiles = fs.readdirSync(osContentPath).filter((n) => n.endsWith('.zip'));

  const n = zipFiles.length;
  if (n === 0) {
    progress?.report({ message: 'No SDK component ZIPs found.', increment: opts.range });
  } else {
    progress?.report({ message: 'Extracting SDK components...', increment: 0 });
  }

  const base = n > 0 ? Math.floor(opts.range / n) : 0;
  let rem = n > 0 ? opts.range % n : 0;
  let cursor = opts.start;

  for (const zipFile of zipFiles) {
    checkCancelled();
    logger.info(`Extracting component ${zipFile}`);
    const zipPath = path.join(osContentPath, zipFile);
    const thisBudget = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    await extractZipWithProgress({ zipPath, dest: osContentPath, progress, start: cursor, range: thisBudget, logger });
    cursor += thisBudget;
    fs.unlinkSync(zipPath);
  }

  progress?.report({ message: 'Finalizing installation...', increment: 0 });
  if (fs.existsSync(sdkInstallDir)) {
    fs.rmSync(sdkInstallDir, { recursive: true, force: true });
  }
  movePath(osContentPath, sdkInstallDir);
  progress?.report({ message: 'Finalizing installation...', increment: 3 });
}

export interface InstallSdkFromArchiveOptions {
  config: ConfigProvider;
  /**
   * A local SDK tarball: an `ohos-sdk-full` archive from the daily builds
   * (`OHOS_DAILY_BUILDS_URL`), or a public release downloaded by hand.
   */
  archivePath: string;
  /** Replace an SDK already installed at the archive's API level. */
  force?: boolean;
  progress?: ProgressReporter;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /** Scratch directory for the extract temporaries; see {@link InstallSdkOptions.tmpDir}. */
  tmpDir?: string;
}

export interface InstalledSdk {
  /** API level, from the components' `oh-uni-package.json` (e.g. `26`). */
  api: string;
  /** SDK build version from the same file (e.g. `26.0.0.39`). */
  version: string;
  /** Where it was installed: `<sdkRootDir>/<os>/<api>`. */
  dir: string;
}

/**
 * Install an OpenHarmony SDK from a local tarball into `<sdkRootDir>/<os>/<api>`. This
 * is how the full SDK, which the release mirror does not carry, gets installed.
 *
 * Only the current OS's folder is unpacked, wherever it sits in the archive (the full
 * SDK packs `linux`, `ohos` and `windows` side by side under `ohos-sdk/`), and the API
 * level is read from the components rather than taken from the caller.
 *
 * Progress budget (overall 0..100):
 *   0..40  Tarball extract
 *   40..95 Component ZIP extracts
 *   95..100 Finalize + cleanup
 */
export async function installSdkFromArchive(opts: InstallSdkFromArchiveOptions): Promise<InstalledSdk> {
  const { config, archivePath, progress, abortSignal } = opts;
  const logger = opts.logger ?? noopLogger;
  if (!fs.statSync(archivePath, { throwIfNoEntry: false })?.isFile()) {
    throw new OniroError(`SDK archive not found: ${archivePath}`);
  }

  const osFolder = getOsFolder();
  const what = `the SDK install from '${path.basename(archivePath)}'`;
  const sdkRoot = getSdkRootDir(config);
  const { dir: tmpDir, root: tmpRoot } = createInstallTempDir({
    config,
    override: opts.tmpDir,
    installRoot: sdkRoot,
    prefix: 'oniro-sdk-',
    logger,
  });
  const extractDir = path.join(tmpDir, 'extract');
  fs.mkdirSync(extractDir);

  const checkCancelled = () => {
    if (abortSignal?.aborted) throw new CancelledError();
  };

  try {
    progress?.report({ message: 'Extracting SDK archive (this may take a while)...', increment: 0 });
    await extractTarball(archivePath, extractDir, 0, (p) => p.split('/').includes(osFolder));
    progress?.report({ message: 'Extracting SDK archive (this may take a while)...', increment: 40 });

    checkCancelled();

    const osContentPath = findSdkOsDir(extractDir, osFolder);
    if (!osContentPath) {
      throw new OniroError(
        `No '${osFolder}' SDK components (a '${osFolder}' folder of ZIPs) found in ${archivePath}. ` +
          'Is it an OpenHarmony SDK archive for this OS?',
      );
    }
    const { api, version } = await readSdkComponentsMeta(osContentPath);
    const sdkInstallDir = path.join(sdkRoot, osFolder, api);
    if (fs.existsSync(sdkInstallDir) && !opts.force) {
      throw new OniroError(
        `An SDK for api ${api} is already installed at ${sdkInstallDir}; pass --force to replace it ` +
          'with this archive, or set ONIRO_SDK_ROOT_DIR to install it in a separate SDK root.',
      );
    }
    fs.mkdirSync(path.dirname(sdkInstallDir), { recursive: true });
    await installComponents({ osContentPath, sdkInstallDir, progress, logger, start: 40, range: 55, checkCancelled });

    progress?.report({ message: 'Cleaning up...', increment: 0 });
    removeTempWorkDir(tmpDir, tmpRoot);
    progress?.report({ message: 'Cleaning up...', increment: 2 });
    return { api, version, dir: sdkInstallDir };
  } catch (err) {
    removeTempWorkDir(tmpDir, tmpRoot);
    throw toSpaceError(err, tmpRoot, what);
  }
}

/**
 * The shallowest `<osFolder>` directory under `root` that holds component ZIPs, or
 * undefined. SDK tarballs nest it at different depths (`windows/`, `ohos-sdk/windows/`,
 * deeper on macOS).
 */
export function findSdkOsDir(root: string, osFolder: OsFolder, maxDepth = 4): string | undefined {
  let level = [root];
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = path.join(dir, entry.name);
        if (entry.name === osFolder && fs.readdirSync(p).some((n) => n.endsWith('.zip'))) return p;
        next.push(p);
      }
    }
    level = next;
  }
  return undefined;
}

/**
 * API level and build version of the SDK whose component ZIPs are in `dir`, from the
 * `<component>/oh-uni-package.json` every component carries. The small `ets` component
 * is read first.
 */
async function readSdkComponentsMeta(dir: string): Promise<{ api: string; version: string }> {
  const zips = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.zip'))
    .sort((a, b) => Number(b.startsWith('ets-')) - Number(a.startsWith('ets-')));
  for (const name of zips) {
    const data = await readZipEntry(path.join(dir, name), (e) => /^[^/]+\/oh-uni-package\.json$/.test(e));
    if (!data) continue;
    try {
      const pkg = JSON.parse(data.toString('utf8')) as { apiVersion?: unknown; version?: unknown };
      // The API level becomes a path segment of the install dir, so accept only digits.
      const api = String(pkg.apiVersion ?? '');
      if (/^\d+$/.test(api)) return { api, version: String(pkg.version ?? '') };
    } catch {
      // Not JSON; try the next component.
    }
  }
  throw new OniroError('No SDK component in the archive declares a numeric apiVersion (oh-uni-package.json).');
}
