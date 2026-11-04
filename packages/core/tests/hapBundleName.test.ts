import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bundleNameFromHapConfig, readHapBundleName } from '../src/install/hapBundleName.js';
import { diffHapAssets } from '../src/install/diffHapAssets.js';
import { makeStoredZip } from './_helpers/storedZip.js';

describe('bundleNameFromHapConfig', () => {
  it('reads app.bundleName from module.json or config.json', () => {
    expect(bundleNameFromHapConfig('{"app":{"bundleName":"com.example.app"},"module":{"name":"entry"}}')).toBe(
      'com.example.app',
    );
    expect(bundleNameFromHapConfig('﻿{"app":{"bundleName":"com.example.fa"}}')).toBe('com.example.fa');
  });

  it('returns null when there is no bundle name or the text is not JSON', () => {
    expect(bundleNameFromHapConfig('{"module":{"name":"entry"}}')).toBeNull();
    expect(bundleNameFromHapConfig('{"app":{"bundleName":""}}')).toBeNull();
    expect(bundleNameFromHapConfig('not json')).toBeNull();
  });
});

describe('reading a signed HAP', () => {
  it('reads one whose central directory hap-sign-tool padded past the default read window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-signedhap-'));
    try {
      const hap = path.join(dir, 'entry-default-signed.hap');
      // Like a real signed HAP: ~4 KB of alignment in each directory record.
      fs.writeFileSync(
        hap,
        makeStoredZip([
          { name: 'ets/modules.abc', data: Buffer.alloc(200_000), centralExtra: 4051 },
          { name: 'module.json', data: Buffer.from('{"app":{"bundleName":"com.example.signed"}}'), centralExtra: 3151 },
        ]),
      );
      await expect(readHapBundleName(hap)).resolves.toBe('com.example.signed');
      await expect(diffHapAssets({ installedHap: hap, newHap: hap })).resolves.toEqual({ addedAssetPaths: [], removedAssetPaths: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
