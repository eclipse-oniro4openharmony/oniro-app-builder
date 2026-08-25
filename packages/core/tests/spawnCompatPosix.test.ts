import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { needsCmdWrapper, spawnCompat } from '../src/hdc/spawnCompat.js';
import { getHvigorwPath } from '../src/sdk/paths.js';
import { staticConfig } from '../src/ports/config.js';

/**
 * The cmd.exe shim must be inert everywhere but Windows: on Linux and macOS
 * `spawnCompat` has to be `spawn(cmd, args, { shell: false })` and nothing
 * else. CI runs this suite on Linux, but the guarantee is easy to break from a
 * Windows box where the POSIX branch never executes — so the platform is
 * faked here and the assertions run on every host.
 */
const realPlatform = process.platform;
const fakePlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
};

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('spawnCompat is a no-op off Windows', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    it(`does not route a .cmd through cmd.exe on ${platform}`, () => {
      fakePlatform(platform);
      // Even a path that WOULD be wrapped on Windows must be handed to the OS
      // verbatim here — on a real POSIX host there is no cmd.exe to route to.
      expect(needsCmdWrapper('/opt/tools/ohpm.cmd')).toBe(false);
    });

    it(`passes the command and args straight through on ${platform}`, async () => {
      fakePlatform(platform);
      const child = spawnCompat(process.execPath, [
        '-e',
        'process.stdout.write(process.argv.slice(1).join("|"))',
        'a b',
        'x&y',
      ]);
      const out = await new Promise<string>((resolve) => {
        let buf = '';
        child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
        child.on('close', () => resolve(buf));
      });
      // No quoting, no carets: the argv the child sees is exactly what we passed.
      expect(out).toBe('a b|x&y');
    });
  }

  it('hands a .cmd to the OS exactly as bare spawn would', () => {
    fakePlatform('linux');
    // Asserted as "same outcome as spawn" rather than a fixed error, so the
    // test says the same thing on a Linux host (async ENOENT) as on a Windows
    // one (synchronous EINVAL). Either way the point holds: the POSIX branch
    // never reaches cmd.exe, which would have launched successfully.
    const outcome = (run: () => ChildProcess): string => {
      try {
        run().on('error', () => {});
        return 'spawned';
      } catch (err) {
        return (err as NodeJS.ErrnoException).code ?? 'threw';
      }
    };
    const viaCompat = outcome(() => spawnCompat('/definitely/not/here.cmd', []));
    const viaSpawn = outcome(() => spawn('/definitely/not/here.cmd', [], { shell: false }));
    expect(viaCompat).toBe(viaSpawn);
  });
});

describe('getHvigorwPath keeps the POSIX candidate order', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers the extensionless shell script on linux and darwin', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hvigorw-'));
    // Both wrappers present, as a DevEco project ships them.
    fs.writeFileSync(path.join(dir, 'hvigorw'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'hvigorw.bat'), '@echo off\r\n');
    fs.mkdirSync(path.join(dir, 'hvigor', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hvigor', 'hvigor-wrapper.js'), '');

    const config = staticConfig({ cmdToolsPath: path.join(dir, 'cmdtools') });
    expect(getHvigorwPath(config, dir, 'linux')).toBe(path.join(dir, 'hvigorw'));
    expect(getHvigorwPath(config, dir, 'darwin')).toBe(path.join(dir, 'hvigorw'));
  });
});
