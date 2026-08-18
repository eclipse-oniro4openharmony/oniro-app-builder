import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import followRedirects from 'follow-redirects';
import type { ProgressReporter } from '../ports/progress.js';
import { CancelledError, ChecksumMismatchError, OniroError } from '../ports/errors.js';
import { ensureFreeSpace, isOutOfSpaceError, toSpaceError } from './tmp.js';

const { http, https } = followRedirects;
const pipelineAsync = promisify(pipeline);

export interface DownloadOptions {
  url: string;
  dest: string;
  progress?: ProgressReporter;
  abortSignal?: AbortSignal;
  /** Overall progress start offset (0..100). Default 0. */
  start?: number;
  /** Overall progress range to consume (0..100). Default 100. */
  range?: number;
  /** What the download is for, used in out-of-space messages. */
  what?: string;
  /**
   * Configurable scratch root that `dest` lives under, if any. Out-of-space messages
   * name it instead of the per-run subdirectory, since that is what the user can change.
   */
  tmpRoot?: string;
}

/**
 * Stream a remote file to disk with optional progress reporting and cancellation.
 * Follows redirects via the `follow-redirects` library.
 *
 * Fails fast with an `InsufficientSpaceError` when the destination filesystem cannot
 * hold the advertised `content-length` — the common case being a system temp dir on a
 * RAM-backed tmpfs that is far smaller than the SDK/tools archives.
 */
export async function downloadFile(opts: DownloadOptions): Promise<void> {
  const { url, dest, progress, abortSignal } = opts;
  const proto = url.startsWith('https') ? https : http;

  return new Promise((resolve, reject) => {
    const s = Math.max(0, Math.min(100, opts.start ?? 0));
    const r = Math.max(0, Math.min(100 - s, opts.range ?? 100));

    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };

    if (abortSignal?.aborted) {
      done(new CancelledError('Download cancelled before start.'));
      return;
    }

    const destDir = path.dirname(path.resolve(dest));
    const what = opts.what ?? `the download of '${url}'`;

    // Out of space gets the directory-aware explanation; anything else (a bad path,
    // a permission problem) still surfaces as a typed error rather than a raw fs one.
    const writeFailed = (err: unknown): unknown =>
      isOutOfSpaceError(err)
        ? toSpaceError(err, opts.tmpRoot ?? destDir, what)
        : new OniroError(`Error writing '${dest}': ${err instanceof Error ? err.message : String(err)}`, err);

    const file = fs.createWriteStream(dest);
    let activeResponse: NodeJS.ReadableStream | undefined;

    // Settle only once the partial file is gone, so a caller that retries — or a test
    // that checks — never observes the leftover. Closing before removing keeps Windows
    // happy, where an open file cannot be deleted.
    const failWith = (err: unknown) => {
      file.close(() => fs.rm(dest, { force: true }, () => done(err)));
    };

    // A write-stream failure (most often ENOSPC) has no other listener; without this
    // it would surface as an unhandled 'error' event and take the process down.
    file.on('error', (err) => {
      try { (activeResponse as { destroy?: () => void } | undefined)?.destroy?.(); } catch {}
      failWith(writeFailed(err));
    });

    const req = proto.get(url, (response) => {
      activeResponse = response;
      if (response.statusCode !== 200) {
        try { response.destroy(); } catch {}
        failWith(new OniroError(`Failed to download '${url}' (HTTP ${response.statusCode})`));
        return;
      }

      const total = parseInt(response.headers['content-length'] || '0', 10);

      // Refuse to start rather than filling the filesystem (or RAM, on tmpfs) first.
      if (total > 0) {
        try {
          ensureFreeSpace(opts.tmpRoot ?? destDir, total, what);
        } catch (err) {
          try { response.destroy(); } catch {}
          failWith(err);
          return;
        }
      }

      let downloaded = 0;
      let lastOverall = Math.round(s);

      response.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        if (progress && total) {
          const localPercent = Math.min(100, Math.round((downloaded / total) * 100));
          const overall = Math.min(100, Math.round(s + (downloaded / total) * r));
          const inc = overall - lastOverall;
          if (inc > 0) {
            progress.report({ message: `Downloading: ${localPercent}%`, increment: inc });
            lastOverall = overall;
          } else {
            progress.report({ message: `Downloading: ${localPercent}%`, increment: 0 });
          }
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        if (progress) {
          const endOverall = Math.min(100, Math.round(s + r));
          const inc = endOverall - lastOverall;
          if (inc > 0) progress.report({ message: 'Downloading: 100%', increment: inc });
        }
        file.close((err) => (err ? done(writeFailed(err)) : done()));
      });

      abortSignal?.addEventListener('abort', () => {
        response.destroy();
        failWith(new CancelledError('Download cancelled.'));
      });
    });

    req.on('error', (err) => {
      failWith(new OniroError(`Error downloading '${url}': ${err.message}`, err));
    });

    abortSignal?.addEventListener('abort', () => {
      req.destroy();
      failWith(new CancelledError('Download cancelled.'));
    });
  });
}

/**
 * Verify the SHA-256 checksum of a file against an on-disk .sha256 file.
 * The .sha256 file is expected to contain the hex digest as its first whitespace-delimited token.
 */
export async function verifySha256(filePath: string, sha256Path: string): Promise<void> {
  const expected = fs.readFileSync(sha256Path, 'utf8').split(/\s+/)[0]!;
  const hash = crypto.createHash('sha256');
  await pipelineAsync(fs.createReadStream(filePath), hash);
  const actual = hash.digest('hex');
  if (actual !== expected) {
    throw new ChecksumMismatchError(expected, actual);
  }
}
