import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverHaps } from '../src/build/discoverHaps.js';

describe('discoverHaps', () => {
  let projectDir: string;

  const writeHap = (rel: string): void => {
    const full = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'hap');
  };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-haps-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('groups signed/unsigned HAPs by module folder, skipping node_modules', async () => {
    writeHap('entry/build/default/outputs/default/entry-default-signed.hap');
    writeHap('entry/build/default/outputs/default/entry-default-unsigned.hap');
    writeHap('phone_gestureNavigation/build/default/outputs/default/phone_gestureNavigation-default-signed.hap');
    writeHap('node_modules/some-dep/leftover-signed.hap');
    writeHap('oh_modules/dep/x-signed.hap');

    const haps = await discoverHaps({ projectDir });

    expect(Object.keys(haps).sort()).toEqual(['entry', 'phone_gestureNavigation']);
    expect(haps.entry!.signed).toHaveLength(1);
    expect(haps.entry!.unsigned).toHaveLength(1);
    expect(haps.phone_gestureNavigation!.signed).toHaveLength(1);
    expect(haps.phone_gestureNavigation!.unsigned).toEqual([]);
    expect(haps.entry!.signed[0]).toMatch(/entry-default-signed\.hap$/);
  });

  it('returns {} for a project with no built HAPs', async () => {
    expect(await discoverHaps({ projectDir })).toEqual({});
  });
});
