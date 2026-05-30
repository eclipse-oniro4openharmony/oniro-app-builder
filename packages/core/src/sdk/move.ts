import * as fs from 'node:fs';

/**
 * Move a file or directory from `src` to `dest`.
 *
 * Prefers an atomic `rename`, but transparently falls back to a recursive
 * copy-then-remove when the two paths live on different filesystems. `rename(2)`
 * fails with `EXDEV` across mount boundaries, which happens routinely during
 * install: the OS temp dir (where archives are extracted) and the install target
 * are frequently separate devices — a `tmpfs` `/tmp` with an on-disk home, a Docker
 * volume or bind mount at the install path, an overlay vs. a mounted cache, etc.
 *
 * Callers are expected to have already cleared `dest` if it must be replaced
 * (both current callers `rmSync` first). The copy preserves file modes and
 * symlinks (Node's default `cp` behavior), which the SDK/toolchains rely on.
 */
export function movePath(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Cross-device move: copy the tree, then drop the source.
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}
