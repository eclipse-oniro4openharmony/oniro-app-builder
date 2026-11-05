import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { InsufficientSpaceError } from '../src/ports/errors.js';
import { describeReplacement, installCmdTools, type CmdToolsInfo } from '../src/cmdTools/install.js';
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
    await installCmdTools({ config, localZipPath: v2Zip });
    expect(snapshot(target)).toEqual(V2);
  });

  it('keeps entries of the target that are not the tools', async () => {
    await installCmdTools({ config, localZipPath: v1Zip });
    fs.writeFileSync(path.join(target, 'notes.txt'), 'mine');
    fs.mkdirSync(path.join(target, 'jdk', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(target, 'jdk', 'bin', 'java'), 'java');
    await installCmdTools({ config, localZipPath: v2Zip });
    expect(snapshot(target)).toEqual({ ...V2, 'notes.txt': 'mine', 'jdk/bin/java': 'java' });
  });

  it('keeps the previous tools where the error says when the rollback itself fails', async () => {
    await installCmdTools({ config, localZipPath: v1Zip });
    const before = snapshot(target);
    const parkedCount = fs.readdirSync(target).length;
    let renames = 0;
    const rename = (src: string, dest: string): void => {
      renames++;
      // The swap fails after parking the old entries; the first undo rename fails too.
      if (renames === parkedCount + 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      if (renames === parkedCount + 2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      fs.renameSync(src, dest);
    };

    const err = await installCmdTools({ config, localZipPath: v2Zip, fsOps: { rename } }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/restoring the previous tools failed too/);
    const kept = fs.readdirSync(target).find((n) => n.startsWith('oniro-previous-tools-'));
    expect(kept).toBeDefined();
    expect((err as Error).message).toContain(kept!);
    const restored = { ...snapshot(target) };
    const parked = snapshot(path.join(target, kept!));
    for (const k of Object.keys(restored)) if (k.startsWith(`${kept}/`)) delete restored[k];
    expect({ ...restored, ...parked }).toEqual(before);

    // The next install does not delete them.
    await installCmdTools({ config, localZipPath: v2Zip });
    expect(fs.existsSync(path.join(target, kept!))).toBe(true);
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

  describe('reporting the version change (#25)', () => {
    /** A HarmonyOS tools release as version.txt and sdk-pkg.json describe it. */
    const release = (version: string, hvigor: string, platform: string, api: string): Record<string, string> => ({
      'bin/ohpm': 'ohpm',
      'version.txt': `# Command Line Tools(linux-x64)\n# Version: ${version}\n\nhvigor       : ${hvigor}\napiVersion   : ${api}\n`,
      'sdk/default/hms/.keep': '',
      'sdk/default/sdk-pkg.json': JSON.stringify({
        data: { displayName: `HarmonyOS ${platform}`, platformVersion: platform, apiVersion: api },
      }),
    });
    const logs = (): { lines: string[]; logger: { debug(): void; info(m: string): void; warn(m: string): void; error(m: string): void } } => {
      const lines: string[] = [];
      return { lines, logger: { debug() {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } };
    };

    it('says what replaces what before the old tools go, and returns both', async () => {
      await installCmdTools({ config, localZipPath: toolsZip(dir, 'old.zip', release('5.1.0.840', '5.18.5', '5.1.0', '18')) });
      const { lines, logger } = logs();
      const result = await installCmdTools({
        config,
        logger,
        localZipPath: toolsZip(dir, 'new.zip', release('6.1.1.280', '6.24.2', '6.1.1', '24')),
      });
      expect(lines).toContain(
        'Replacing command-line tools 5.1.0.840 (HarmonyOS 5.1.0, API 18, hvigor 5.18.5) with ' +
          '6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2).',
      );
      expect(lines.some((l) => l.startsWith('hvigor changes major version (5.18.5 -> 6.24.2)'))).toBe(true);
      expect(result.path).toBe(target);
      expect(result.previous).toMatchObject({ version: '5.1.0.840', flavour: 'HarmonyOS', sdk: { apiVersion: '18' } });
      expect(result.installed).toMatchObject({
        version: '6.1.1.280',
        flavour: 'HarmonyOS',
        sdk: { path: path.join(target, 'sdk'), displayName: 'HarmonyOS 6.1.1', apiVersion: '24' },
        tools: { hvigor: '6.24.2' },
      });
    });

    it('reports no previous install for a fresh one', async () => {
      const { lines, logger } = logs();
      const result = await installCmdTools({ config, logger, localZipPath: v2Zip });
      expect(result.previous).toBeUndefined();
      expect(lines.some((l) => l.startsWith('Replacing'))).toBe(false);
    });
  });
});

describe('describeReplacement', () => {
  const info = (version: string, hvigor: string, api: string): CmdToolsInfo => ({
    version,
    flavour: 'HarmonyOS',
    sdk: { path: '/t/sdk', displayName: `HarmonyOS ${version.split('.').slice(0, 3).join('.')}`, apiVersion: api },
    tools: { hvigor },
  });

  it('flags a downgrade, and does not mention hvigor within one major version', () => {
    const lines = describeReplacement(info('6.1.1.280', '6.24.2', '24'), info('6.0.0.868', '6.20.0', '20'));
    expect(lines[0]).toBe(
      'Replacing command-line tools 6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2) with ' +
        '6.0.0.868 (HarmonyOS 6.0.0, API 20, hvigor 6.20.0).',
    );
    expect(lines).toContain('6.0.0.868 is older than the 6.1.1.280 it replaces.');
    expect(lines.some((l) => l.startsWith('hvigor'))).toBe(false);
    expect(lines.some((l) => l.includes('--from-zip <zip> --force'))).toBe(true);
  });

  it('calls the same release a reinstall', () => {
    expect(describeReplacement(info('6.1.1.280', '6.24.2', '24'), info('6.1.1.280', '6.24.2', '24'))).toEqual([
      'Reinstalling command-line tools 6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2).',
    ]);
  });

  it('names a partial install it replaces as of unknown version', () => {
    expect(describeReplacement({ flavour: 'OpenHarmony', tools: {} }, info('6.1.1.280', '6.24.2', '24'))[0]).toBe(
      'Replacing command-line tools unknown version with 6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2).',
    );
  });
});
