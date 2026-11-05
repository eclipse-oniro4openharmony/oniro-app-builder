import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import { defaultPaths } from '../ports/config.js';
import type { ProgressReporter } from '../ports/progress.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError, UnsupportedPlatformError } from '../ports/errors.js';
import { getCmdToolsPath, getHdcPath } from '../sdk/paths.js';
import { downloadFile } from '../sdk/download.js';
import { extractZipWithProgress } from '../sdk/extract.js';
import { movePath } from '../sdk/move.js';
import { buildCmdWrapper, needsCmdWrapper } from '../hdc/spawnCompat.js';
import { createInstallTempDir, removeTempWorkDir, toSpaceError } from '../sdk/tmp.js';
import { readSdkPkg } from '../harmonyos/sdk.js';

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
  /**
   * Scratch directory for the download/extract temporaries. Overrides the `tmpDir`
   * config key and the default location next to the install target.
   */
  tmpDir?: string;
  /**
   * Filesystem seams for tests: `move` stages each extracted entry inside the
   * install directory (default {@link movePath}), `rename` swaps entries in and
   * out of it (default `fs.renameSync`).
   * @internal
   */
  fsOps?: Partial<CmdToolsFsOps>;
}

export interface InstallCmdToolsResult {
  /** The install directory. */
  path: string;
  /** What is installed now. */
  installed: CmdToolsInfo;
  /** What the install replaced; absent when the directory was missing or empty. */
  previous?: CmdToolsInfo;
}

/** Compare dotted numeric versions; NaN parts count as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * What `installCmdTools` says when it replaces an install: which release replaces
 * which, and when hvigor changes major version or the new release is older, that
 * too. Pure.
 */
export function describeReplacement(previous: CmdToolsInfo, next: CmdToolsInfo): string[] {
  const before = describeCmdTools(previous);
  const after = describeCmdTools(next);
  if (before === after) return [`Reinstalling command-line tools ${after}.`];
  const lines = [`Replacing command-line tools ${before} with ${after}.`];
  const oldHvigor = previous.tools.hvigor;
  const newHvigor = next.tools.hvigor;
  if (oldHvigor && newHvigor && oldHvigor.split('.')[0] !== newHvigor.split('.')[0]) {
    lines.push(
      `hvigor changes major version (${oldHvigor} -> ${newHvigor}): every project built with these tools, ` +
        'or with their bin/ on PATH, gets the new one.',
    );
  }
  if (previous.version && next.version && compareVersions(next.version, previous.version) < 0) {
    lines.push(`${next.version} is older than the ${previous.version} it replaces.`);
  }
  if (previous.version && previous.version !== next.version) {
    lines.push(
      `The ${previous.version} tools are deleted; to go back, reinstall them from their ZIP with ` +
        '`oniro-app cmdtools install --from-zip <zip> --force`.',
    );
  }
  return lines;
}

/** @internal */
export interface CmdToolsFsOps {
  move: (src: string, dest: string) => void;
  rename: (src: string, dest: string) => void;
}

/**
 * This module's own work directories inside the install target. A run killed
 * outright can leave one behind; the next install removes it.
 */
const STAGING_PREFIX = '.oniro-staging-';
const PREVIOUS_PREFIX = '.oniro-previous-';

function isWorkDirName(name: string): boolean {
  return name.startsWith(STAGING_PREFIX) || name.startsWith(PREVIOUS_PREFIX);
}

/**
 * Top-level entries a command-line tools release holds (OpenHarmony and HarmonyOS
 * flavours). An install replaces these and whatever the new archive brings; any
 * other entry of the target is not the tools' and stays, since `cmdToolsPath` may
 * point at a directory that holds other things too.
 */
const TOOL_ENTRIES = new Set([
  'bin',
  'codelinter',
  'hstack',
  'hvigor',
  'ohpm',
  'sdk',
  'tool',
  'version.txt',
  'LICENSE.txt',
  'NOTICE.txt',
]);

/**
 * Replace the contents of `target` with those of `staging` (a directory inside
 * `target`), leaving `target` as it was when any rename fails. Returns the
 * directory now holding the previous contents, for the caller to delete.
 *
 * Every step is a rename within `target`, so nothing is copied here and the disk
 * cannot fill up part-way. That holds even when `target` is a mount point (a
 * Docker volume, a bind mount), which renaming `target` itself would not survive.
 * `keep` names entries of `target` to leave alone (a scratch directory inside it).
 */
function swapInto(
  target: string,
  staging: string,
  keep: ReadonlySet<string>,
  rename: CmdToolsFsOps['rename'],
): string {
  const suffix = path.basename(staging).slice(STAGING_PREFIX.length);
  const previous = path.join(target, PREVIOUS_PREFIX + suffix);
  fs.mkdirSync(previous);
  const incoming = fs.readdirSync(staging);
  const replaced = new Set([...incoming, ...TOOL_ENTRIES]);
  const parked: string[] = [];
  const placed: string[] = [];
  try {
    for (const entry of fs.readdirSync(target)) {
      if (isWorkDirName(entry) || keep.has(entry) || !replaced.has(entry)) continue;
      rename(path.join(target, entry), path.join(previous, entry));
      parked.push(entry);
    }
    for (const entry of incoming) {
      rename(path.join(staging, entry), path.join(target, entry));
      placed.push(entry);
    }
  } catch (err) {
    // Undo in reverse: the new entries out, the old ones back.
    for (const entry of placed.reverse()) {
      fs.rmSync(path.join(target, entry), { recursive: true, force: true });
    }
    try {
      for (const entry of [...parked].reverse()) {
        rename(path.join(previous, entry), path.join(target, entry));
      }
    } catch (undoErr) {
      // The previous tools are still parked. Move them out of the work-directory
      // namespace, which the next install empties, and say where they are.
      const kept = path.join(target, `oniro-previous-tools-${suffix}`);
      let where = previous;
      try {
        fs.renameSync(previous, kept);
        where = kept;
      } catch {
        // Leave them where they are; the message names that directory.
      }
      throw new OniroError(
        `Installing the command-line tools failed (${(err as Error).message}), and restoring the previous tools ` +
          `failed too (${(undoErr as Error).message}). The previous tools are in ${where}: move its contents back ` +
          `into ${target} by hand.`,
      );
    }
    fs.rmSync(previous, { recursive: true, force: true });
    throw err;
  }
  return previous;
}

/**
 * Install the OpenHarmony command-line tools into `<cmdToolsPath>`.
 * Either downloads from the platform-specific URL or installs from a caller-supplied ZIP.
 *
 * The archive is extracted to scratch space and staged inside the install
 * directory; only once the whole tree is staged are its entries swapped in for the
 * old ones. A failure before that (a full disk mid-copy, say) leaves the install
 * directory as it was, and one during the swap rolls it back (#16). A successful
 * install replaces the directory's contents outright, so it holds exactly what a
 * clean extraction of the archive holds, whatever an earlier failed attempt or an
 * older version left there. Entries that are not the tools' (see `TOOL_ENTRIES`) stay.
 *
 * When it replaces an install, it logs which release replaces which before the
 * old one is deleted, and returns both (#25).
 */
export async function installCmdTools(opts: InstallCmdToolsOptions): Promise<InstallCmdToolsResult> {
  const { config, progress, abortSignal } = opts;
  const logger = opts.logger ?? noopLogger;
  const move = opts.fsOps?.move ?? movePath;
  const rename = opts.fsOps?.rename ?? fs.renameSync;
  const CMD_PATH = path.resolve(getCmdToolsPath(config));
  const what = 'the command-line tools install';
  const createdTarget = !fs.existsSync(CMD_PATH);
  const previous =
    !createdTarget && fs.readdirSync(CMD_PATH).some((n) => !isWorkDirName(n)) ? readCmdToolsInfo(CMD_PATH) : undefined;
  let staging: string | undefined;

  const { dir: tmpDir, root: tmpRoot } = createInstallTempDir({
    config,
    override: opts.tmpDir,
    installRoot: path.dirname(CMD_PATH),
    prefix: 'oniro-cmdtools-',
    logger,
  });
  const zipPath = opts.localZipPath ?? path.join(tmpDir, 'oh-command-line-tools.zip');
  const extractPath = path.join(tmpDir, 'oh-command-line-tools');

  try {
    if (!opts.localZipPath) {
      const url = getCmdToolsDownloadUrl(config);
      progress?.report({ message: 'Downloading command line tools...', increment: 0 });
      await downloadFile({ url, dest: zipPath, progress, abortSignal, start: 0, range: 50, what, tmpRoot });
    }

    progress?.report({ message: 'Extracting tools...', increment: 0 });
    await extractZipWithProgress({ zipPath, dest: extractPath, progress, start: 50, range: 45, logger });
    const srcDir = findCmdToolsSourceDir(extractPath);

    fs.mkdirSync(CMD_PATH, { recursive: true });
    for (const leftover of fs.readdirSync(CMD_PATH).filter(isWorkDirName)) {
      logger.debug(`[cmdtools] Removing ${leftover}, left behind by an interrupted install.`);
      fs.rmSync(path.join(CMD_PATH, leftover), { recursive: true, force: true });
    }
    // Staged inside the target, so the swap below is renames on one filesystem.
    staging = fs.mkdtempSync(path.join(CMD_PATH, STAGING_PREFIX));
    for (const entry of fs.readdirSync(srcDir)) {
      move(path.join(srcDir, entry), path.join(staging, entry));
    }

    const binDir = path.join(staging, 'bin');
    if (fs.existsSync(binDir) && os.platform() !== 'win32') {
      for (const file of fs.readdirSync(binDir)) {
        fs.chmodSync(path.join(binDir, file), 0o755);
      }
    }

    progress?.report({ message: 'Finalizing installation...', increment: 5 });
    // A scratch directory the caller placed inside the install target stays put.
    const tmpRel = path.relative(CMD_PATH, path.resolve(tmpRoot));
    const keep = new Set<string>(
      tmpRel && !tmpRel.startsWith('..') && !path.isAbsolute(tmpRel) ? [tmpRel.split(path.sep)[0]!] : [],
    );
    // Say what is replaced by what before the old tools go: they serve every
    // project on the machine, and a newer bundle may not be downloadable again (#25).
    if (previous) {
      for (const line of describeReplacement(previous, readCmdToolsInfo(staging))) logger.info(line);
    }
    const parked = swapInto(CMD_PATH, staging, keep, rename);
    progress?.report({ message: 'Cleaning up...', increment: 0 });
    try {
      fs.rmSync(parked, { recursive: true, force: true });
    } catch (err) {
      // The new tools are in place; the next install removes what is left.
      logger.warn(`Could not remove the previous tools at ${parked}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { path: CMD_PATH, installed: readCmdToolsInfo(CMD_PATH), ...(previous ? { previous } : {}) };
  } catch (err) {
    // Nothing of the user's was there before this run.
    if (createdTarget) fs.rmSync(CMD_PATH, { recursive: true, force: true });
    throw toSpaceError(err, tmpRoot, what);
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    removeTempWorkDir(tmpDir, tmpRoot);
  }
}

export interface CmdToolsStatus {
  installed: boolean;
  status: string;
  /** Install directory (the configured `cmdToolsPath`). */
  path: string;
  /** Which SDK flavour the tools ship; see {@link detectCmdToolsFlavour}. Set when installed. */
  flavour?: CmdToolsFlavour;
  /** The hdc binary commands use, and whether it exists. */
  hdc: { path: string; exists: boolean };
  /** The bundle release, e.g. `6.1.1.280`, as in `status`. Set when known. */
  version?: string;
  /** The SDK the tools bundle (the HarmonyOS SDK, in the HarmonyOS edition). Set when installed and present. */
  sdk?: CmdToolsSdk;
  /** Versions of the tools inside, from `version.txt`, e.g. `{ hvigor: '6.24.2', ohpm: '6.1.2.268' }`. */
  tools?: Record<string, string>;
}

export type CmdToolsFlavour = 'HarmonyOS' | 'OpenHarmony';

/** The SDK a command-line tools install ships under `sdk/`. */
export interface CmdToolsSdk {
  /** The `sdk` directory, which HarmonyOS builds receive as `DEVECO_SDK_HOME`. */
  path: string;
  /** e.g. `HarmonyOS 6.1.1`. */
  displayName?: string;
  /** e.g. `6.1.1`. */
  platformVersion?: string;
  /** e.g. `24`. */
  apiVersion?: string;
  /** The SDK build, e.g. `6.1.1.125`. */
  build?: string;
}

/** What a command-line tools install holds: its release, flavour, SDK and tool versions. */
export interface CmdToolsInfo {
  /** From `version.txt` (`# Version: 6.1.1.280`). */
  version?: string;
  flavour: CmdToolsFlavour;
  sdk?: CmdToolsSdk;
  /** Tool versions `version.txt` lists (`hvigor : 6.24.2`). */
  tools: Record<string, string>;
}

/** version.txt keys that are not tools. */
const NON_TOOL_KEYS = new Set(['apiVersion', 'releaseType']);

/**
 * Read what the command-line tools at `cmdToolsPath` are, from `version.txt` and
 * `sdk/default/sdk-pkg.json`. Fields it cannot find are left out. Pure file reads.
 */
export function readCmdToolsInfo(cmdToolsPath: string): CmdToolsInfo {
  const info: CmdToolsInfo = { flavour: detectCmdToolsFlavour(cmdToolsPath), tools: {} };
  let apiFromVersionTxt: string | undefined;
  try {
    for (const line of fs.readFileSync(path.join(cmdToolsPath, 'version.txt'), 'utf8').split(/\r?\n/)) {
      const release = /^\s*#\s*Version:\s*(.+)$/.exec(line);
      if (release?.[1]) {
        info.version ??= release[1].trim();
        continue;
      }
      const kv = /^\s*([a-z][\w-]*)\s*:\s*(\S.*?)\s*$/.exec(line);
      if (!kv) continue;
      if (kv[1] === 'apiVersion') apiFromVersionTxt = kv[2];
      else if (!NON_TOOL_KEYS.has(kv[1]!)) info.tools[kv[1]!] = kv[2]!;
    }
  } catch {
    // No version.txt: an older or partial install.
  }
  const sdkPath = path.join(cmdToolsPath, 'sdk');
  if (fs.existsSync(path.join(sdkPath, 'default'))) {
    const { displayName, platformVersion, apiVersion, build } = readSdkPkg(sdkPath);
    const sdk: CmdToolsSdk = { path: sdkPath };
    if (displayName) sdk.displayName = displayName;
    if (platformVersion) sdk.platformVersion = platformVersion;
    if (apiVersion ?? apiFromVersionTxt) sdk.apiVersion = apiVersion ?? apiFromVersionTxt;
    if (build) sdk.build = build;
    info.sdk = sdk;
  }
  return info;
}

/**
 * One line naming a tools install: `6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2)`,
 * leaving out what is unknown.
 */
export function describeCmdTools(info: { version?: string; sdk?: CmdToolsSdk; tools?: Record<string, string> }): string {
  const details = [
    info.sdk?.displayName,
    info.sdk?.apiVersion ? `API ${info.sdk.apiVersion}` : undefined,
    info.tools?.hvigor ? `hvigor ${info.tools.hvigor}` : undefined,
  ].filter(Boolean);
  const version = info.version ?? 'unknown version';
  return details.length ? `${version} (${details.join(', ')})` : version;
}

/**
 * The flavour of a command-line tools install: `HarmonyOS` when it bundles the
 * HarmonyOS SDK (`sdk/default/hms`, as the Huawei developer-portal download
 * does), otherwise `OpenHarmony`. codelinter only fully checks projects of its
 * own flavour (`runtimeOS` in build-profile.json5).
 */
export function detectCmdToolsFlavour(cmdToolsPath: string): CmdToolsFlavour {
  return fs.existsSync(path.join(cmdToolsPath, 'sdk', 'default', 'hms')) ? 'HarmonyOS' : 'OpenHarmony';
}

/**
 * Reports whether ohpm is present at the configured path, and if so its version,
 * flavour, the SDK it bundles, its tools' versions (see {@link readCmdToolsInfo})
 * and the hdc binary in use. The version comes from `version.txt`
 * (`# Version: x.y.z`), else from running ohpm with `-v`.
 */
export function getCmdToolsStatus(config: ConfigProvider): CmdToolsStatus {
  const cmdPath = getCmdToolsPath(config);
  const hdcPath = getHdcPath(config);
  const base = { path: cmdPath, hdc: { path: hdcPath, exists: fs.existsSync(hdcPath) } };
  const binDir = path.join(cmdPath, 'bin');
  const candidates = os.platform() === 'win32'
    ? ['ohpm.exe', 'ohpm.cmd', 'ohpm.bat', 'ohpm']
    : ['ohpm'];
  const bin = candidates.map((c) => path.join(binDir, c)).find((p) => fs.existsSync(p));
  if (!bin) {
    return { installed: false, status: 'Not installed', ...base };
  }
  const info = readCmdToolsInfo(cmdPath);
  const installed: CmdToolsStatus = {
    installed: true,
    status: '',
    ...base,
    flavour: info.flavour,
    ...(info.sdk ? { sdk: info.sdk } : {}),
    ...(Object.keys(info.tools).length ? { tools: info.tools } : {}),
  };
  if (info.version) return { ...installed, status: `Installed (${info.version})`, version: info.version };

  try {
    // `ohpm` is a .bat wrapper on Windows, which cannot be spawned directly
    // (EINVAL since Node 20.12.2) — go through cmd.exe there.
    const wrapped = needsCmdWrapper(bin);
    const probe = wrapped ? buildCmdWrapper(bin, ['-v']) : { command: bin, args: ['-v'] };
    const res = spawnSync(probe.command, probe.args, {
      encoding: 'utf8',
      windowsVerbatimArguments: wrapped,
    });
    if (res.error || res.status !== 0) throw res.error ?? new Error(`exit ${String(res.status)}`);
    const version = res.stdout.trim();
    return { ...installed, status: `Installed (${version})`, version };
  } catch {
    return { ...installed, status: 'Installed (version unknown)' };
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
