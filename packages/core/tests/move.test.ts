import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

// node:fs built-in exports are non-configurable, so vi.spyOn can't redefine them.
// Mock the module instead: renameSync routes through a controllable mock (passthrough
// by default), every other fs call stays real so the copy fallback runs for real.
const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  renameMock.mockImplementation(actual.renameSync);
  return { ...actual, default: actual, renameSync: renameMock };
});

import * as fs from 'node:fs';
import { movePath } from '../src/sdk/move.js';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('movePath', () => {
  // The mock factory already wires renameMock's default impl to the real renameSync.
  afterEach(() => renameMock.mockClear());

  it('moves a directory tree via rename (same filesystem)', () => {
    const root = tmp('move-rename-');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
      fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'world');

      movePath(src, dest);

      expect(renameMock).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('hello');
      expect(fs.readFileSync(path.join(dest, 'sub', 'b.txt'), 'utf8')).toBe('world');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to a real copy+remove when rename hits EXDEV (cross-device)', () => {
    const root = tmp('move-exdev-');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'a.txt'), 'payload');
      fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'nested');

      // Simulate src and dest on different filesystems for the next rename only.
      renameMock.mockImplementationOnce(() => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      });

      movePath(src, dest);

      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('payload');
      expect(fs.readFileSync(path.join(dest, 'sub', 'b.txt'), 'utf8')).toBe('nested');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rethrows non-EXDEV rename errors (does not silently copy)', () => {
    renameMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    expect(() => movePath('/whatever/src', '/whatever/dest')).toThrow(/EPERM/);
  });
});
