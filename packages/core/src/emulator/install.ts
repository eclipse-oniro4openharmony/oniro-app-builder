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

export interface InstallEmulatorOptions {
  config: ConfigProvider;
  progress?: ProgressReporter;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/**
 * Download and extract the Oniro emulator into the configured `emulatorDir`.
 */
export async function installEmulator(opts: InstallEmulatorOptions): Promise<void> {
  const { config, progress, abortSignal } = opts;
  const logger = opts.logger ?? noopLogger;

  const url = config.get('emulatorUrl', defaultPaths.emulatorUrl);
  const emulatorDir = getEmulatorDir(config);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-emulator-'));
  const tmpZip = path.join(tmpDir, 'oniro_emulator.zip');

  try {
    fs.mkdirSync(emulatorDir, { recursive: true });

    progress?.report({ message: 'Downloading emulator...', increment: 0 });
    await downloadFile({ url, dest: tmpZip, progress, abortSignal, start: 0, range: 50 });

    progress?.report({ message: 'Extracting emulator...', increment: 0 });
    await extractZipWithProgress({ zipPath: tmpZip, dest: emulatorDir, progress, start: 50, range: 45, logger });

    const runSh = path.join(emulatorDir, 'images', 'run.sh');
    if (fs.existsSync(runSh)) {
      fs.chmodSync(runSh, 0o755);
    }
    progress?.report({ message: 'Finalizing installation...', increment: 5 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
