import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import * as tar from 'tar';
import StreamZip from 'node-stream-zip';
import type { ProgressReporter } from '../ports/progress.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';

const pipelineAsync = promisify(pipeline);

export interface ExtractZipOptions {
  zipPath: string;
  dest: string;
  progress?: ProgressReporter;
  /** Overall progress start offset (0..100). Default 0. */
  start?: number;
  /** Overall progress range to consume (0..100). Default 100. */
  range?: number;
  logger?: Logger;
}

/**
 * Extract a ZIP to a destination directory, preserving file permissions and following
 * symlinks defensively. Protects against Zip Slip (entries whose paths escape `dest`).
 */
export async function extractZipWithProgress(opts: ExtractZipOptions): Promise<void> {
  const { zipPath, dest, progress } = opts;
  const logger = opts.logger ?? noopLogger;

  const zip = new (StreamZip as unknown as { async: new (cfg: { file: string }) => StreamZipAsync }).async({ file: zipPath });
  const entries = await zip.entries();
  const files = Object.values(entries);
  const total = files.length || 1;

  const s = Math.max(0, Math.min(100, opts.start ?? 0));
  const r = Math.max(0, Math.min(100 - s, opts.range ?? 100));

  let processed = 0;
  let lastOverall = Math.round(s);

  await fs.promises.mkdir(dest, { recursive: true });
  const destRoot = path.resolve(dest);

  const safeResolveTarget = (entryName: string): string => {
    const resolved = path.resolve(destRoot, entryName);
    const rel = path.relative(destRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new OniroError(`Blocked ZIP entry with illegal path: ${entryName}`);
    }
    return resolved;
  };

  try {
    for (const file of files) {
      const entryName = file.name;
      const targetPath = safeResolveTarget(entryName);
      const attr = file.attr ? (file.attr >>> 16) : 0;
      const isSymlink = 'isSymbolicLink' in file
        ? Boolean(file.isSymbolicLink)
        : (attr & 0o170000) === 0o120000;

      if (file.isDirectory) {
        await fs.promises.mkdir(targetPath, { recursive: true });
      } else if (isSymlink) {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        const linkTargetBuffer = await zip.entryData(file);
        const linkTarget = linkTargetBuffer.toString('utf8');
        try {
          const isWin = os.platform() === 'win32';
          await fs.promises.symlink(linkTarget, targetPath, isWin ? 'file' : undefined);
        } catch (e) {
          logger.warn(`Failed to create symlink at ${targetPath}: ${String(e)}`);
        }
      } else {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        const readStream = await zip.stream(file);
        const writeStream = fs.createWriteStream(targetPath);
        await pipelineAsync(readStream, writeStream);
        if (attr > 0) {
          try {
            await fs.promises.chmod(targetPath, attr & 0o777);
          } catch {
            // Best-effort: Windows or filesystems without POSIX perms — ignore.
          }
        }
      }

      processed++;
      if (progress) {
        const localPercent = Math.min(100, Math.round((processed / total) * 100));
        const overall = Math.min(100, Math.round(s + (processed / total) * r));
        const inc = overall - lastOverall;
        if (inc > 0) {
          progress.report({ message: `Extracting: ${localPercent}%`, increment: inc });
          lastOverall = overall;
        } else {
          progress.report({ message: `Extracting: ${localPercent}%`, increment: 0 });
        }
      }
    }
  } finally {
    await zip.close();
  }

  if (progress) {
    const endOverall = Math.min(100, Math.round(s + r));
    const inc = endOverall - lastOverall;
    if (inc > 0) progress.report({ message: 'Extracting: 100%', increment: inc });
  }
}

/**
 * Extract a tar/tar.gz/tar.bz2 archive. Wraps `tar.x`.
 */
export async function extractTarball(tarPath: string, dest: string, strip = 0): Promise<void> {
  await tar.x({ file: tarPath, cwd: dest, strip });
}

// node-stream-zip's TypeScript types aren't great; this is the minimal shape we use.
interface ZipEntry {
  name: string;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  attr?: number;
}
interface StreamZipAsync {
  entries(): Promise<Record<string, ZipEntry>>;
  entryData(entry: ZipEntry): Promise<Buffer>;
  stream(entry: ZipEntry): Promise<NodeJS.ReadableStream>;
  close(): Promise<void>;
}
