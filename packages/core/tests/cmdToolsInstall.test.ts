import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { InsufficientSpaceError } from '../src/ports/errors.js';
import { installCmdTools } from '../src/cmdTools/install.js';
import { movePath } from '../src/sdk/move.js';
import { makeStoredZip } from './_helpers/storedZip.js';

/** A command-line tools ZIP: `command-line-tools/<path>` for each file. */
function toolsZip(dir: string, name: string, files: Record<string, string>): string {
  const zip = path.join(dir, name);
  fs.writeFileSync(
    zip,
    makeStoredZip(Object.entries(files).map(([p, data]) => ({ name: `command-line-tools/${p}`, data: Buffer.from(data) }))),
  );
  return zip;
}

/** Every file under `root`, relative, with its contents. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

const V1 = {
  'bin/ohpm': 'ohpm 1',
  'bin/hvigorw': 'hvigorw 1',
  'version.txt': '# Version: 5.1.0.840\n',
  'sdk/default/openharmony/toolchains/hdc': 'hdc 1',
  'sdk/default/openharmony/ets/only-in-v1.d.ts': 'old',
  'hvigor/hvigor.js': 'hvigor 5',
};
const V2 = {
  'bin/ohpm': 'ohpm 2',
  'bin/hvigorw': 'hvigorw 2',
  'bin/codelinter': 'codelinter 2',
  'version.txt': '# Version: 6.1.1.280\n',
  'sdk/default/openharmony/toolchains/hdc': 'hdc 2',
  'hvigor/hvigor.js': 'hvigor 6',
  'tool/node/bin/node': 'node',
};

describe('installCmdTools', () => {
  let dir: string;
  let target: string;
  let v1Zip: string;
  let v2Zip: string;
  let config: ReturnType<typeof staticConfig>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cmdtools-install-'));
    target = path.join(dir, 'command-line-tools');
    v1Zip = toolsZip(dir, 'v1.zip', V1);
    v2Zip = toolsZip(dir, 'v2.zip', V2);
    config = staticConfig({ cmdToolsPath: target });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A move that fails like a full disk once `after` entries are staged, the next one half-copied. */
  function failingMove(after: number): (src: string, dest: string) => void {
    let moved = 0;
    return (src, dest) => {
      if (moved++ < after) return movePath(src, dest);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'truncated'), 'partial');
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${dest}'`), { code: 'ENOSPC', path: dest });
    };
  }

  it('installs into a missing directory exactly what the archive holds', async () => {
    await installCmdTools({ config, localZipPath: v2Zip });
    expect(snapshot(target)).toEqual(V2);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(target, 'bin', 'ohpm')).mode & 0o111).not.toBe(0);
    }
  });

  it('replaces an older install outright: nothing of it is left', async () => {
    await installCmdTools({ config, localZipPath: v1Zip });
    fs.writeFileSync(path.join(target, 'stray.txt'), 'left by hand');
    await installCmdTools({ config, localZipPath: v2Zip });
    expect(snapshot(target)).toEqual(V2);
  });

  it('leaves the existing install untouched when staging fails mid-copy, and a retry equals a clean install', async () => {
    await installCmdTools({ config, localZipPath: v1Zip });
    const before = snapshot(target);

    await expect(
      installCmdTools({ config, localZipPath: v2Zip, fsOps: { move: failingMove(2) } }),
    ).rejects.toBeInstanceOf(InsufficientSpaceError);
    expect(snapshot(target)).toEqual(before);
    expect(fs.readdirSync(target).filter((n) => n.startsWith('.oniro-'))).toEqual([]);

    await installCmdTools({ config, localZipPath: v2Zip });
    const clean = path.join(dir, 'clean');
    await installCmdTools({ config: staticConfig({ cmdToolsPath: clean }), localZipPath: v2Zip });
    expect(snapshot(target)).toEqual(snapshot(clean));
  });

  it('rolls the install back when the swap fails part-way', async () => {
    await installCmdTools({ config, localZipPath: v1Zip });
    const before = snapshot(target);
    const parkedCount = fs.readdirSync(target).length;
    let renames = 0;
    const rename = (src: string, dest: string): void => {
      // Fail once the old entries are parked and some new ones are in place.
      if (++renames === parkedCount + 2) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      fs.renameSync(src, dest);
    };

    await expect(installCmdTools({ config, localZipPath: v2Zip, fsOps: { rename } })).rejects.toThrow('EIO');
    expect(snapshot(target)).toEqual(before);
    expect(fs.readdirSync(target).filter((n) => n.startsWith('.oniro-'))).toEqual([]);
  });

  it('does not leave a new install directory behind when the first install fails', async () => {
    await expect(
      installCmdTools({ config, localZipPath: v2Zip, fsOps: { move: failingMove(1) } }),
    ).rejects.toBeInstanceOf(InsufficientSpaceError);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('removes work directories a killed install left behind', async () => {
    await installCmdTools({ config, localZipPath: v1Zip });
    fs.mkdirSync(path.join(target, '.oniro-staging-abc123', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(target, '.oniro-previous-def456'), { recursive: true });
    await installCmdTools({ config, localZipPath: v2Zip });
    expect(snapshot(target)).toEqual(V2);
  });
});
