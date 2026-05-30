import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { ProgressReporter } from '../ports/progress.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError, UnsupportedPlatformError } from '../ports/errors.js';
import { getCmdToolsPath } from '../sdk/paths.js';
import { downloadFile } from '../sdk/download.js';
import { extractZipWithProgress } from '../sdk/extract.js';
import { movePath } from '../sdk/move.js';

/**
 * Resolve the per-platform download URL for the OpenHarmony command-line tools.
 *
 * Only Linux has a public download URL on the Huawei mirror. Windows and macOS
 * builds are gated behind the Huawei developer portal: users must download the
 * ZIP manually and pass it via `--from-zip`, or self-host the archive and point
 * `cmdToolsUrlWindows` / `cmdToolsUrlMac` at it.
 *
 * @param platform Defaults to the current host. Override for testing.
 */
export function getCmdToolsDownloadUrl(config: ConfigProvider, platform: NodeJS.Platform = os.platform()): string {
  if (platform === 'linux') {
    return config.get('cmdToolsUrlLinux', defaultPaths.cmdToolsUrlLinux);
  }
  if (platform === 'win32') {
    const url = config.get('cmdToolsUrlWindows', '');
    if (!url) {
      throw new OniroError(
        'No Windows command-line tools URL configured. The Huawei mirror does not host a public Windows build; ' +
          'download the ZIP from the Huawei developer portal and run `oniro-app cmdtools install --from-zip <path>`, ' +
          'or set ONIRO_CMD_TOOLS_URL_WINDOWS to a self-hosted URL.',
      );
    }
    return url;
  }
  if (platform === 'darwin') {
    const url = config.get('cmdToolsUrlMac', '');
    if (!url) {
      throw new OniroError(
        'No macOS command-line tools URL configured. The Huawei mirror does not host a public macOS build; ' +
          'download the ZIP from the Huawei developer portal and run `oniro-app cmdtools install --from-zip <path>`, ' +
          'or set ONIRO_CMD_TOOLS_URL_MAC to a self-hosted URL.',
      );
    }
    return url;
  }
  throw new UnsupportedPlatformError(platform);
}

/**
 * Locate the extracted command-line tools' source root within a temp extraction folder.
 * Tries known top-level names, then any subdirectory containing a `bin/` folder.
 */
export function findCmdToolsSourceDir(extractPath: string): string {
  const known = [
    path.join(extractPath, 'command-line-tools'),
    path.join(extractPath, 'oh-command-line-tools'),
    path.join(extractPath, 'commandline-tools'),
  ];
  for (const c of known) {
    if (fs.existsSync(c)) return c;
  }
  const entries = fs
    .readdirSync(extractPath, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(extractPath, e.name));
  for (const dir of entries) {
    if (fs.existsSync(path.join(dir, 'bin'))) return dir;
  }
  throw new OniroError('Could not locate command line tools folder in the extracted archive.');
}

export interface InstallCmdToolsOptions {
  config: ConfigProvider;
  progress?: ProgressReporter;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /** Skip download and install from a local zip the caller already has. */
  localZipPath?: string;
}

/**
 * Install the OpenHarmony command-line tools into `<cmdToolsPath>`.
 * Either downloads from the platform-specific URL or installs from a caller-supplied ZIP.
 */
export async function installCmdTools(opts: InstallCmdToolsOptions): Promise<void> {
  const { config, progress, abortSignal } = opts;
  const logger = opts.logger ?? noopLogger;
  const CMD_PATH = getCmdToolsPath(config);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cmdtools-'));
  const zipPath = opts.localZipPath ?? path.join(tmpDir, 'oh-command-line-tools.zip');
  const extractPath = path.join(tmpDir, 'oh-command-line-tools');

  try {
    if (!opts.localZipPath) {
      const url = getCmdToolsDownloadUrl(config);
      progress?.report({ message: 'Downloading command line tools...', increment: 0 });
      await downloadFile({ url, dest: zipPath, progress, abortSignal, start: 0, range: 50 });
    }

    progress?.report({ message: 'Extracting tools...', increment: 0 });
    await extractZipWithProgress({ zipPath, dest: extractPath, progress, start: 50, range: 45, logger });

    fs.mkdirSync(CMD_PATH, { recursive: true });
    const srcDir = findCmdToolsSourceDir(extractPath);

    for (const entry of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, entry);
      const dest = path.join(CMD_PATH, entry);
      if (fs.statSync(src).isDirectory()) {
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        movePath(src, dest);
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    const binDir = path.join(CMD_PATH, 'bin');
    if (fs.existsSync(binDir) && os.platform() !== 'win32') {
      for (const file of fs.readdirSync(binDir)) {
        fs.chmodSync(path.join(binDir, file), 0o755);
      }
    }

    progress?.report({ message: 'Finalizing installation...', increment: 5 });
    progress?.report({ message: 'Cleaning up...', increment: 0 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface CmdToolsStatus {
  installed: boolean;
  status: string;
}

/**
 * Reports whether ohpm is present at the configured path, and if so its version.
 * Prefers reading `version.txt` (`# Version: x.y.z`) before falling back to executing
 * the binary with `-v`.
 */
export function getCmdToolsStatus(config: ConfigProvider): CmdToolsStatus {
  const cmdPath = getCmdToolsPath(config);
  const binDir = path.join(cmdPath, 'bin');
  const candidates = os.platform() === 'win32'
    ? ['ohpm.exe', 'ohpm.cmd', 'ohpm.bat', 'ohpm']
    : ['ohpm'];
  const bin = candidates.map((c) => path.join(binDir, c)).find((p) => fs.existsSync(p));
  if (!bin) {
    return { installed: false, status: 'Not installed' };
  }

  // Prefer version.txt.
  try {
    const versionFile = path.join(cmdPath, 'version.txt');
    if (fs.existsSync(versionFile)) {
      const content = fs.readFileSync(versionFile, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*#\s*Version:\s*(.+)$/);
        if (m?.[1]) return { installed: true, status: `Installed (${m[1].trim()})` };
      }
    }
  } catch {
    // Fall through to exec.
  }

  try {
    const version = execFileSync(bin, ['-v'], { encoding: 'utf8' }).trim();
    return { installed: true, status: `Installed (${version})` };
  } catch {
    return { installed: true, status: 'Installed (version unknown)' };
  }
}

export function isCmdToolsInstalled(config: ConfigProvider): boolean {
  return getCmdToolsStatus(config).installed;
}

export function removeCmdTools(config: ConfigProvider): void {
  const cmdPath = getCmdToolsPath(config);
  if (fs.existsSync(cmdPath)) {
    fs.rmSync(cmdPath, { recursive: true, force: true });
  }
}
