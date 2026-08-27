import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { InsufficientSpaceError, OniroError } from '../ports/errors.js';

/** Name of the scratch folder created next to an install target. */
export const INSTALL_TMP_DIRNAME = '.oniro-tmp';

/** `statfs` type magics for the Linux filesystems whose capacity comes out of RAM. */
const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

const HINT_EXAMPLE = os.platform() === 'win32' ? 'D:\\oniro-tmp' : '~/.cache/oniro-tmp';

/** Advice appended to out-of-space failures in the scratch directory. */
export const TMP_DIR_HINT =
  'Point the scratch directory at a filesystem with more room using --tmp-dir <path> ' +
  `(or the ONIRO_TMP_DIR environment variable), e.g. --tmp-dir ${HINT_EXAMPLE}.`;

/**
 * Resolve the directory that download/extract scratch space is created in.
 *
 * Precedence: explicit override (CLI `--tmp-dir`) → `tmpDir` config key
 * (`ONIRO_TMP_DIR`) → `<installRoot>/.oniro-tmp` → the system temp dir.
 *
 * The default sits next to the install target so that the unpacked tree is renamed
 * into place rather than copied across a device boundary, and so the system temp dir
 * — a RAM-backed `tmpfs` on most Linux systems, and far smaller than a multi-GB
 * archive — is never in the picture.
 */
export function resolveTmpRoot(config: ConfigProvider, override?: string, installRoot?: string): string {
  const explicit = (override ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const configured = config.get('tmpDir', '').trim();
  if (configured) return path.resolve(configured);
  if (installRoot) return path.join(path.resolve(installRoot), INSTALL_TMP_DIRNAME);
  return os.tmpdir();
}

/** Create a private scratch directory under `root`, creating `root` if needed. */
export function createTempWorkDir(root: string, prefix: string): string {
  try {
    fs.mkdirSync(root, { recursive: true });
    return fs.mkdtempSync(path.join(root, prefix));
  } catch (err) {
    if (isOutOfSpaceError(err)) throw toSpaceError(err, root, 'a temporary directory');
    throw new OniroError(
      `Cannot create a temporary directory in '${root}': ${err instanceof Error ? err.message : String(err)}\n${TMP_DIR_HINT}`,
      err,
    );
  }
}

/**
 * Remove a scratch directory once an install is done, taking the `.oniro-tmp` root
 * with it when that leaves it empty. A root the caller named explicitly is left alone,
 * as are roots another install is still using (the rmdir simply fails).
 */
export function removeTempWorkDir(dir: string, root?: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!root || path.basename(root) !== INSTALL_TMP_DIRNAME) return;
  try {
    fs.rmdirSync(root);
  } catch {
    // Not empty (a concurrent install) or already gone — nothing to do.
  }
}

export interface InstallTempDirOptions {
  config: ConfigProvider;
  /** Explicit scratch directory (CLI `--tmp-dir`). */
  override?: string;
  /** Directory the install lands in; the default scratch root is created inside it. */
  installRoot: string;
  prefix: string;
  logger?: Logger;
}

export interface InstallTempDir {
  /** The private per-run scratch directory. Remove it when the install finishes. */
  dir: string;
  /** The configurable root it was created under, for out-of-space messages. */
  root: string;
}

/**
 * Create the scratch directory for an install, defaulting to `<installRoot>/.oniro-tmp`.
 *
 * When that default is unusable — a read-only or root-owned install parent, say — the
 * system temp dir is used instead. A directory the caller asked for explicitly is never
 * swapped out silently, and a full filesystem is reported rather than papered over.
 */
export function createInstallTempDir(opts: InstallTempDirOptions): InstallTempDir {
  const requested =
    (opts.override ?? '').trim() || opts.config.get('tmpDir', '').trim();
  const root = resolveTmpRoot(opts.config, opts.override, opts.installRoot);

  try {
    return { dir: createTempWorkDir(root, opts.prefix), root };
  } catch (err) {
    const fallback = os.tmpdir();
    if (requested || isOutOfSpaceError(err) || path.resolve(fallback) === path.resolve(root)) throw err;
    const reason = err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err);
    (opts.logger ?? noopLogger).warn(`${reason} Falling back to '${fallback}'.`);
    return { dir: createTempWorkDir(fallback, opts.prefix), root: fallback };
  }
}

/** Nearest existing ancestor of `dir` (or null if even the root is unreadable). */
function nearestExisting(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Bytes available to an unprivileged user on the filesystem holding `dir`.
 * Returns null when the platform cannot report it.
 */
export function getFreeSpaceBytes(dir: string): number | null {
  const target = nearestExisting(dir);
  if (!target) return null;
  try {
    const stats = fs.statfsSync(target);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return null;
  }
}

/**
 * Whether `dir` lives on a RAM-backed filesystem (`tmpfs`/`ramfs`), i.e. one whose
 * capacity comes out of memory rather than disk.
 */
export function isRamBackedPath(dir: string): boolean {
  const target = nearestExisting(dir);
  if (!target) return false;
  try {
    const type = Number(fs.statfsSync(target).type);
    return type === TMPFS_MAGIC || type === RAMFS_MAGIC;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Recognise an out-of-disk-space failure from fs/stream errors and their wrappers. */
export function isOutOfSpaceError(err: unknown): boolean {
  if (err instanceof InsufficientSpaceError) return true;
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === 'ENOSPC' || e.code === 'EDQUOT') return true;
    if (typeof e.message === 'string' && /ENOSPC|EDQUOT|no space left on device/i.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}

/** The user-facing "no room" explanation, with a way out when the temp dir is to blame. */
function spaceMessage(
  dir: string,
  what: string,
  opts: { requiredBytes?: number | null; freeBytes?: number | null; tmpDirHint: boolean },
): string {
  const need = typeof opts.requiredBytes === 'number' ? `needs about ${formatBytes(opts.requiredBytes)}` : null;
  const free = typeof opts.freeBytes === 'number' ? `${formatBytes(opts.freeBytes)} available` : null;
  const amounts = [need, free].filter(Boolean).join(', ');

  const lines = [`Not enough free space in '${dir}' for ${what}${amounts ? ` (${amounts})` : ''}.`];
  if (isRamBackedPath(dir)) {
    lines.push(
      `'${dir}' is on a RAM-backed filesystem (tmpfs), so its capacity is limited by free memory, not by free disk.`,
    );
  }
  if (opts.tmpDirHint) lines.push(TMP_DIR_HINT);
  return lines.join('\n');
}

/**
 * Fail before writing a byte when the filesystem holding `dir` cannot take
 * `requiredBytes`. A no-op when free space cannot be determined.
 */
export function ensureFreeSpace(dir: string, requiredBytes: number, what: string): void {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) return;
  const freeBytes = getFreeSpaceBytes(dir);
  if (freeBytes === null || freeBytes >= requiredBytes) return;
  throw new InsufficientSpaceError(
    spaceMessage(dir, what, { requiredBytes, freeBytes, tmpDirHint: true }),
    dir,
  );
}

/** The filesystem path an fs error refers to, from anywhere in its cause chain. */
function errorPath(err: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const e = current as { path?: unknown; dest?: unknown; cause?: unknown };
    if (typeof e.path === 'string' && e.path) return e.path;
    if (typeof e.dest === 'string' && e.dest) return e.dest;
    current = e.cause;
  }
  return null;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Convert an out-of-space failure into an {@link InsufficientSpaceError}; any other
 * error is returned unchanged, so callers can `throw toSpaceError(err, ...)`.
 *
 * `tmpRoot` is the scratch directory the operation was using. Failures under it are
 * reported against it (not the per-run subdirectory the user cannot configure) and get
 * the `--tmp-dir` remedy; failures elsewhere — an install target that is full — name
 * their own directory and skip the remedy, which would not help.
 */
export function toSpaceError(err: unknown, tmpRoot: string, what: string): unknown {
  if (err instanceof InsufficientSpaceError) return err;
  if (!isOutOfSpaceError(err)) return err;

  const failed = errorPath(err);
  const failedDir = failed ? path.dirname(path.resolve(failed)) : path.resolve(tmpRoot);
  const inTmp = isInside(failedDir, tmpRoot);
  const dir = inTmp ? path.resolve(tmpRoot) : failedDir;
  return new InsufficientSpaceError(
    spaceMessage(dir, what, { freeBytes: getFreeSpaceBytes(dir), tmpDirHint: inTmp }),
    dir,
    err,
  );
}
