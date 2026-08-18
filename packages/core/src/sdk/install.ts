import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { ProgressReporter } from '../ports/progress.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { OHOS_URL_BASE } from './constants.js';
import { getSdkFilename } from './platform.js';
import { getSdkRootDir } from './paths.js';
import { downloadFile, verifySha256 } from './download.js';
import { extractTarball, extractZipWithProgress } from './extract.js';
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
    const zipFiles = fs.readdirSync(osContentPath).filter((n) => n.endsWith('.zip'));

    const componentsStart = 60;
    const componentsBudget = 35;
    const n = zipFiles.length;
    if (n === 0) {
      progress?.report({ message: 'No SDK component ZIPs found.', increment: componentsBudget });
    } else {
      progress?.report({ message: 'Extracting SDK components...', increment: 0 });
    }

    const base = n > 0 ? Math.floor(componentsBudget / n) : 0;
    let rem = n > 0 ? componentsBudget % n : 0;
    let cursor = componentsStart;

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
