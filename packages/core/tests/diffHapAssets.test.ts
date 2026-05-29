import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffHapAssets } from '../src/install/diffHapAssets.js';

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

/** Build a minimal STORED (uncompressed) zip — enough for node-stream-zip `.entries()`. */
function makeStoredZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(f.data.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    local.push(lfh, nameBuf, f.data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(f.data.length, 20);
    cdh.writeUInt32LE(f.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + f.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, eocd]);
}

describe('diffHapAssets', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hapdiff-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports added/removed file paths between two HAPs', async () => {
    const installed = path.join(dir, 'installed.hap');
    const next = path.join(dir, 'new.hap');
    fs.writeFileSync(installed, makeStoredZip([
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'resources/x.png', data: Buffer.from('x') },
    ]));
    fs.writeFileSync(next, makeStoredZip([
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'resources/y.png', data: Buffer.from('y') },
    ]));

    expect(await diffHapAssets({ installedHap: installed, newHap: next })).toEqual({
      addedAssetPaths: ['resources/y.png'],
      removedAssetPaths: ['resources/x.png'],
    });
  });

  it('reports no change for identical manifests', async () => {
    const a = path.join(dir, 'a.hap');
    const b = path.join(dir, 'b.hap');
    const files = [{ name: 'a.txt', data: Buffer.from('a') }];
    fs.writeFileSync(a, makeStoredZip(files));
    fs.writeFileSync(b, makeStoredZip(files));
    expect(await diffHapAssets({ installedHap: a, newHap: b })).toEqual({ addedAssetPaths: [], removedAssetPaths: [] });
  });
});
