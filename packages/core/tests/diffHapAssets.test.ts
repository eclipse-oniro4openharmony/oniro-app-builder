import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffHapAssets } from '../src/install/diffHapAssets.js';
import { makeStoredZip } from './_helpers/storedZip.js';

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
