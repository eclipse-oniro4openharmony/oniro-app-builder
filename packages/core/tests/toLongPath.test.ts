import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { toLongPath } from '../src/sdk/paths.js';

const isWin = process.platform === 'win32';

/**
 * Ask cmd.exe for the 8.3 alias of `p` (`%~sI`). Returns null when the volume
 * has 8.3 name creation disabled, which is a supported Windows configuration —
 * there is simply no short name to expand there.
 */
function shortNameOf(p: string): string | null {
  // execSync (not execFileSync) so cmd.exe parses the `%~sI` line itself
  // instead of Node escaping the inner quotes into the argument value.
  const out = execSync(`for %I in ("${p}") do @echo %~sI`, { encoding: 'utf8' }).trim();
  return out && out.toLowerCase() !== p.toLowerCase() ? out : null;
}

describe('toLongPath', () => {
  it('is a no-op off Windows, where short names do not exist', () => {
    // Asserted through the injected platform so it holds when run from Windows.
    expect(toLongPath('/opt/some/project', 'linux')).toBe('/opt/some/project');
    expect(toLongPath('/Users/me/project', 'darwin')).toBe('/Users/me/project');
  });

  it('returns a non-existent path unchanged rather than throwing', () => {
    // Callers report this path back in "not found" errors, so it must survive
    // verbatim instead of becoming an exception.
    const missing = path.join(os.tmpdir(), 'oniro-does-not-exist-4d9f2a');
    expect(toLongPath(missing)).toBe(missing);
  });

  describe.skipIf(!isWin)('on Windows', () => {
    let dir: string;

    beforeEach(() => {
      // A name well over 8 characters, so the volume mints an 8.3 alias for it.
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-longname-directory-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('expands an 8.3 short path back to its long form', () => {
      const canonical = fs.realpathSync.native(dir);
      const short = shortNameOf(canonical);
      if (!short) return; // 8.3 creation disabled on this volume — nothing to expand.

      expect(short).not.toBe(canonical);
      expect(toLongPath(short)).toBe(canonical);
    });

    it('expands a short path that has long segments below it', () => {
      // The real shape of the bug: hvigor was handed `<short>\entry` and could
      // not resolve the module directory under it.
      const nested = path.join(dir, 'entry');
      fs.mkdirSync(nested);
      const short = shortNameOf(fs.realpathSync.native(dir));
      if (!short) return;

      expect(toLongPath(path.join(short, 'entry'))).toBe(fs.realpathSync.native(nested));
    });

    it('leaves an already-long path alone', () => {
      const canonical = fs.realpathSync.native(dir);
      expect(toLongPath(canonical)).toBe(canonical);
    });
  });
});
