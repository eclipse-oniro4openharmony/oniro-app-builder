import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { InsufficientSpaceError, OniroError } from '../src/ports/errors.js';
import {
  createInstallTempDir,
  createTempWorkDir,
  INSTALL_TMP_DIRNAME,
  removeTempWorkDir,
  ensureFreeSpace,
  formatBytes,
  getFreeSpaceBytes,
  isOutOfSpaceError,
  resolveTmpRoot,
  toSpaceError,
  TMP_DIR_HINT,
} from '../src/sdk/tmp.js';

const enospc = (p?: string): NodeJS.ErrnoException => {
  const err: NodeJS.ErrnoException = new Error(
    `ENOSPC: no space left on device, write${p ? ` '${p}'` : ''}`,
  );
  err.code = 'ENOSPC';
  if (p) err.path = p;
  return err;
};

describe('resolveTmpRoot', () => {
  const installRoot = path.resolve('/opt/oniro');

  it('defaults to a scratch dir next to the install target', () => {
    expect(resolveTmpRoot(staticConfig({}), undefined, installRoot)).toBe(
      path.join(installRoot, INSTALL_TMP_DIRNAME),
    );
  });

  it('falls back to the system temp dir when there is no install target', () => {
    expect(resolveTmpRoot(staticConfig({}))).toBe(os.tmpdir());
  });

  it('uses the tmpDir config key (ONIRO_TMP_DIR) over the install target', () => {
    const cfg = staticConfig({ tmpDir: '/var/tmp/oniro' });
    expect(resolveTmpRoot(cfg, undefined, installRoot)).toBe(path.resolve('/var/tmp/oniro'));
  });

  it('lets an explicit override win over config', () => {
    const cfg = staticConfig({ tmpDir: '/var/tmp/oniro' });
    expect(resolveTmpRoot(cfg, '/mnt/big/scratch', installRoot)).toBe(path.resolve('/mnt/big/scratch'));
  });

  it('ignores a blank override', () => {
    const cfg = staticConfig({ tmpDir: '/var/tmp/oniro' });
    expect(resolveTmpRoot(cfg, '   ', installRoot)).toBe(path.resolve('/var/tmp/oniro'));
  });
});

describe('createInstallTempDir', () => {
  let installRoot: string;

  beforeEach(() => {
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-install-'));
  });

  afterEach(() => {
    fs.rmSync(installRoot, { recursive: true, force: true });
  });

  const make = (over: Partial<Parameters<typeof createInstallTempDir>[0]> = {}) =>
    createInstallTempDir({ config: staticConfig({}), installRoot, prefix: 'oniro-test-', ...over });

  it('puts the scratch dir next to the install target by default', () => {
    const { dir, root } = make();
    expect(root).toBe(path.join(installRoot, INSTALL_TMP_DIRNAME));
    expect(path.dirname(dir)).toBe(root);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('honours an explicit override', () => {
    const elsewhere = path.join(installRoot, 'elsewhere');
    const { dir, root } = make({ override: elsewhere });
    expect(root).toBe(path.resolve(elsewhere));
    expect(path.dirname(dir)).toBe(path.resolve(elsewhere));
  });

  it('falls back to the system temp dir when the install target is unwritable', () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const asFile = path.join(installRoot, 'a-file');
    fs.writeFileSync(asFile, 'not a directory');

    const { dir, root } = make({ installRoot: path.join(asFile, 'nested'), logger });
    expect(root).toBe(os.tmpdir());
    expect(fs.existsSync(dir)).toBe(true);
    expect(warnings.join('\n')).toContain(os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removeTempWorkDir takes the empty .oniro-tmp root with it', () => {
    const { dir, root } = make();
    removeTempWorkDir(dir, root);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('removeTempWorkDir leaves a root the caller named, and a root still in use', () => {
    const explicit = path.join(installRoot, 'explicit');
    const { dir, root } = make({ override: explicit });
    removeTempWorkDir(dir, root);
    expect(fs.existsSync(explicit)).toBe(true);

    const first = make();
    const second = make();
    removeTempWorkDir(second.dir, second.root);
    expect(fs.existsSync(first.dir)).toBe(true);
    expect(fs.existsSync(first.root)).toBe(true);
  });

  it('never swaps out a directory the caller asked for explicitly', () => {
    const asFile = path.join(installRoot, 'a-file');
    fs.writeFileSync(asFile, 'not a directory');
    expect(() => make({ override: path.join(asFile, 'nested') })).toThrowError(OniroError);
  });
});

describe('createTempWorkDir', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-tmproot-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates the scratch dir inside the given root, creating the root if missing', () => {
    const target = path.join(root, 'does', 'not', 'exist', 'yet');
    const dir = createTempWorkDir(target, 'oniro-test-');
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.dirname(dir)).toBe(path.resolve(target));
    expect(path.basename(dir).startsWith('oniro-test-')).toBe(true);
  });

  it('reports an unusable temp dir with the --tmp-dir hint', () => {
    const asFile = path.join(root, 'a-file');
    fs.writeFileSync(asFile, 'not a directory');
    let caught: unknown;
    try {
      createTempWorkDir(path.join(asFile, 'sub'), 'oniro-test-');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OniroError);
    expect((caught as Error).message).toContain(TMP_DIR_HINT);
  });
});

describe('free space checks', () => {
  it('getFreeSpaceBytes reports a positive number for the temp dir', () => {
    const free = getFreeSpaceBytes(os.tmpdir());
    expect(free === null || free > 0).toBe(true);
  });

  it('getFreeSpaceBytes falls back to the nearest existing ancestor', () => {
    const missing = path.join(os.tmpdir(), 'oniro-definitely-missing', 'deep', 'path');
    expect(getFreeSpaceBytes(missing)).toBe(getFreeSpaceBytes(os.tmpdir()));
  });

  it('ensureFreeSpace throws an InsufficientSpaceError when the requirement cannot fit', () => {
    let caught: unknown;
    try {
      ensureFreeSpace(os.tmpdir(), Number.MAX_SAFE_INTEGER, 'the test download');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InsufficientSpaceError);
    const message = (caught as Error).message;
    expect(message).toContain(os.tmpdir());
    expect(message).toContain('the test download');
    expect(message).toContain(TMP_DIR_HINT);
  });

  it('ensureFreeSpace is a no-op for a requirement that obviously fits', () => {
    expect(() => ensureFreeSpace(os.tmpdir(), 1, 'the test download')).not.toThrow();
  });
});

describe('isOutOfSpaceError', () => {
  it('detects ENOSPC by code', () => {
    expect(isOutOfSpaceError(enospc())).toBe(true);
  });

  it('detects ENOSPC nested in a cause chain', () => {
    expect(isOutOfSpaceError(new OniroError('wrapped', enospc()))).toBe(true);
  });

  it('detects a quota failure', () => {
    const err: NodeJS.ErrnoException = new Error('disk quota exceeded');
    err.code = 'EDQUOT';
    expect(isOutOfSpaceError(err)).toBe(true);
  });

  it('is false for unrelated errors', () => {
    expect(isOutOfSpaceError(new Error('connection reset'))).toBe(false);
    expect(isOutOfSpaceError(undefined)).toBe(false);
  });
});

describe('toSpaceError', () => {
  const tmpRoot = path.join(os.tmpdir(), 'oniro-scratch');

  it('passes non-space errors through untouched', () => {
    const err = new Error('HTTP 404');
    expect(toSpaceError(err, tmpRoot, 'the install')).toBe(err);
  });

  it('wraps an ENOSPC inside the scratch dir with the --tmp-dir hint', () => {
    const wrapped = toSpaceError(enospc(path.join(tmpRoot, 'archive.zip')), tmpRoot, 'the install');
    expect(wrapped).toBeInstanceOf(InsufficientSpaceError);
    const message = (wrapped as Error).message;
    expect(message).toContain(tmpRoot);
    expect(message).toContain('the install');
    expect(message).toContain(TMP_DIR_HINT);
  });

  it('omits the --tmp-dir hint when the full filesystem is the install target', () => {
    const installTarget = path.join(os.homedir(), 'command-line-tools', 'bin', 'ohpm');
    const wrapped = toSpaceError(enospc(installTarget), tmpRoot, 'the install');
    expect(wrapped).toBeInstanceOf(InsufficientSpaceError);
    const message = (wrapped as Error).message;
    expect(message).toContain(path.dirname(installTarget));
    expect(message).not.toContain(TMP_DIR_HINT);
  });

  it('names the configurable scratch root, not the per-run subdirectory', () => {
    const workDir = path.join(tmpRoot, 'oniro-cmdtools-Ab12Cd');
    const wrapped = toSpaceError(enospc(path.join(workDir, 'archive.zip')), tmpRoot, 'the install');
    const message = (wrapped as Error).message;
    expect(message).toContain(`'${tmpRoot}'`);
    expect(message).not.toContain('oniro-cmdtools-Ab12Cd');
  });

  it('keeps an existing InsufficientSpaceError as-is', () => {
    const original = new InsufficientSpaceError('boom', tmpRoot);
    expect(toSpaceError(original, tmpRoot, 'the install')).toBe(original);
  });
});

describe('formatBytes', () => {
  it('formats byte counts in binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GiB');
  });
});
