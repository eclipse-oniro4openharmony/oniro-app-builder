import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import followRedirects from 'follow-redirects';
import type { ProgressReporter } from '../ports/progress.js';
import { CancelledError, ChecksumMismatchError, OniroError } from '../ports/errors.js';

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
}

/**
 * Stream a remote file to disk with optional progress reporting and cancellation.
 * Follows redirects via the `follow-redirects` library.
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

    const file = fs.createWriteStream(dest);

    const req = proto.get(url, (response) => {
      if (response.statusCode !== 200) {
        try { response.destroy(); } catch {}
        try { file.close(); } catch {}
        fs.unlink(dest, () => {});
        done(new OniroError(`Failed to download '${url}' (HTTP ${response.statusCode})`));
        return;
      }

      const total = parseInt(response.headers['content-length'] || '0', 10);
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
        file.close((err) => (err ? done(err) : done()));
      });

      abortSignal?.addEventListener('abort', () => {
        response.destroy();
        file.close();
        fs.unlink(dest, () => {});
        done(new CancelledError('Download cancelled.'));
      });
    });

    req.on('error', (err) => {
      try { file.close(); } catch {}
      fs.unlink(dest, () => {});
      done(new OniroError(`Error downloading '${url}': ${err.message}`, err));
    });

    abortSignal?.addEventListener('abort', () => {
      req.destroy();
      file.close();
      fs.unlink(dest, () => {});
      done(new CancelledError('Download cancelled.'));
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
