import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { downloadFile } from '../src/sdk/download.js';
import { InsufficientSpaceError } from '../src/ports/errors.js';
import { TMP_DIR_HINT } from '../src/sdk/tmp.js';

/**
 * Serves a body whose advertised content-length is far larger than any filesystem,
 * so the pre-download space check must reject it before a byte is written.
 */
const HUGE = Number.MAX_SAFE_INTEGER;

describe('downloadFile free-space preflight', () => {
  let server: http.Server;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/huge') {
        res.writeHead(200, { 'content-length': String(HUGE) });
        res.write('partial');
        return; // never completes: the client should bail out on the headers alone
      }
      const body = Buffer.from('hello oniro');
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-dl-'));
  });

  afterAll(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails fast with actionable guidance when content-length exceeds free space', async () => {
    const dest = path.join(dir, 'huge.bin');
    await expect(downloadFile({ url: `${baseUrl}/huge`, dest, what: 'the test download' }))
      .rejects.toThrowError(InsufficientSpaceError);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('names the directory, the operation, and the --tmp-dir remedy', async () => {
    let caught: unknown;
    try {
      await downloadFile({ url: `${baseUrl}/huge`, dest: path.join(dir, 'huge.bin'), what: 'the test download' });
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;
    expect(message).toContain(dir);
    expect(message).toContain('the test download');
    expect(message).toContain(TMP_DIR_HINT);
  });

  // /dev/full accepts opens and fails every write with ENOSPC — the closest thing to a
  // full filesystem without mounting one. Guards the write-stream error handler:
  // without it the ENOSPC surfaced as an unhandled 'error' event and killed the process.
  const hasDevFull = process.platform === 'linux' && fs.existsSync('/dev/full');
  it.skipIf(!hasDevFull)('maps a mid-write ENOSPC to InsufficientSpaceError instead of crashing', async () => {
    await expect(downloadFile({ url: `${baseUrl}/small`, dest: '/dev/full', what: 'the test download' }))
      .rejects.toThrowError(InsufficientSpaceError);
  });

  it('downloads normally when the file fits', async () => {
    const dest = path.join(dir, 'small.bin');
    await downloadFile({ url: `${baseUrl}/small`, dest });
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello oniro');
  });
});
