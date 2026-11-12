import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { ProgressReporter } from '../ports/progress.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { getEmulatorDir } from '../sdk/paths.js';
import { downloadFile } from '../sdk/download.js';
import { extractZipWithProgress } from '../sdk/extract.js';
import { createInstallTempDir, removeTempWorkDir, toSpaceError } from '../sdk/tmp.js';

/** Guest architecture of an Oniro emulator image. */
export type EmulatorArch = 'x86_64' | 'arm64';

export const EMULATOR_ARCHES: readonly EmulatorArch[] = ['x86_64', 'arm64'];

/**
 * The emulator architecture this host runs with a hypervisor: arm64 on Apple Silicon
 * and other arm64 hosts, x86_64 everywhere else. Pure/testable.
 */
export function hostEmulatorArch(arch: string = os.arch()): EmulatorArch {
  return arch === 'arm64' ? 'arm64' : 'x86_64';
}

/** The default download URL of the emulator for `arch`. */
export function defaultEmulatorUrl(arch: EmulatorArch): string {
  return arch === 'arm64' ? defaultPaths.emulatorUrlArm64 : defaultPaths.emulatorUrl;
}

/**
 * The URLs `installEmulator` tries, in order. An explicit `emulatorUrl` (ONIRO_EMULATOR_URL)
 * always wins. Without an explicit `arch` an arm64 host asks for the arm64 emulator and,
 * while a release has no arm64 asset, falls back to the x86_64 one (which such hosts run
 * under TCG, as before). Pure/testable.
 */
export function emulatorDownloadUrls(
  configuredUrl: string,
  arch: EmulatorArch | undefined,
  hostArch: EmulatorArch = hostEmulatorArch(),
): string[] {
  if (configuredUrl) return [configuredUrl];
  if (arch) return [defaultEmulatorUrl(arch)];
  return hostArch === 'arm64'
    ? [defaultEmulatorUrl('arm64'), defaultEmulatorUrl('x86_64')]
    : [defaultEmulatorUrl('x86_64')];
}

/**
 * The guest architecture of the installed emulator, from the kernel it ships: `Image`
 * (arm64) or `bzImage` (x86_64). Undefined when neither is there.
 */
export function installedEmulatorArch(config: ConfigProvider): EmulatorArch | undefined {
  const imagesDir = path.join(getEmulatorDir(config), 'images');
  if (fs.existsSync(path.join(imagesDir, 'Image'))) return 'arm64';
  if (fs.existsSync(path.join(imagesDir, 'bzImage'))) return 'x86_64';
  return undefined;
}

export interface InstallEmulatorOptions {
  config: ConfigProvider;
  /**
   * Guest architecture to install. Default: the host's (arm64 on Apple Silicon), with a
   * fallback to x86_64 when the release has no arm64 emulator. Ignored when
   * `emulatorUrl` (ONIRO_EMULATOR_URL) is set.
   */
  arch?: EmulatorArch;
  progress?: ProgressReporter;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /**
   * Scratch directory for the downloaded ZIP. Overrides the `tmpDir` config key and
   * the default location next to the install target.
   */
  tmpDir?: string;
}

/**
 * Download and extract the Oniro emulator into the configured `emulatorDir`.
 */
export async function installEmulator(opts: InstallEmulatorOptions): Promise<void> {
  const { config, progress, abortSignal } = opts;
  const logger = opts.logger ?? noopLogger;

  const urls = emulatorDownloadUrls(config.get('emulatorUrl', ''), opts.arch);
  const emulatorDir = getEmulatorDir(config);
  const what = 'the emulator install';
  const { dir: tmpDir, root: tmpRoot } = createInstallTempDir({
    config,
    override: opts.tmpDir,
    installRoot: path.dirname(emulatorDir),
    prefix: 'oniro-emulator-',
    logger,
  });
  const tmpZip = path.join(tmpDir, 'oniro_emulator.zip');

  try {
    fs.mkdirSync(emulatorDir, { recursive: true });

    progress?.report({ message: 'Downloading emulator...', increment: 0 });
    for (const [i, url] of urls.entries()) {
      try {
        await downloadFile({ url, dest: tmpZip, progress, abortSignal, start: 0, range: 50, what, tmpRoot });
        break;
      } catch (err) {
        const next = urls[i + 1];
        if (!next || !/\(HTTP 404\)/.test((err as Error).message)) throw err;
        logger.warn(`No emulator at ${url}; installing ${next} instead.`);
      }
    }

    progress?.report({ message: 'Extracting emulator...', increment: 0 });
    await extractZipWithProgress({ zipPath: tmpZip, dest: emulatorDir, progress, start: 50, range: 45, logger });

    const runSh = path.join(emulatorDir, 'images', 'run.sh');
    if (fs.existsSync(runSh)) {
      fs.chmodSync(runSh, 0o755);
    }
    progress?.report({ message: 'Finalizing installation...', increment: 5 });
  } catch (err) {
    throw toSpaceError(err, tmpRoot, what);
  } finally {
    removeTempWorkDir(tmpDir, tmpRoot);
  }
}

/**
 * Heuristic: the emulator is considered installed if either bundled launcher
 * (`images/run.sh` or `images/run.bat`) is present, so a Windows-only build is
 * detected too.
 */
export function isEmulatorInstalled(config: ConfigProvider): boolean {
  const imagesDir = path.join(getEmulatorDir(config), 'images');
  return fs.existsSync(path.join(imagesDir, 'run.sh')) || fs.existsSync(path.join(imagesDir, 'run.bat'));
}

export function removeEmulator(config: ConfigProvider): void {
  const emulatorDir = getEmulatorDir(config);
  if (fs.existsSync(emulatorDir)) {
    fs.rmSync(emulatorDir, { recursive: true, force: true });
  }
}
