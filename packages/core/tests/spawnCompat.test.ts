import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCmdWrapper,
  escapeCmdArgument,
  escapeCmdCommand,
  needsCmdWrapper,
  spawnCompat,
} from '../src/hdc/spawnCompat.js';
import { OniroError } from '../src/ports/errors.js';
import { runProcess } from '../src/hdc/exec.js';
import { staticConfig } from '../src/ports/config.js';
import { setHilogLevel, streamHilog } from '../src/hdc/hilog.js';
import { listRunningProcesses } from '../src/hdc/app.js';

const isWin = process.platform === 'win32';

describe('needsCmdWrapper', () => {
  it('flags .bat and .cmd on Windows, case-insensitively', () => {
    expect(needsCmdWrapper('C:\\tools\\bin\\ohpm.bat', 'win32')).toBe(true);
    expect(needsCmdWrapper('C:\\tools\\bin\\hvigorw.CMD', 'win32')).toBe(true);
  });

  it('leaves real executables alone on Windows', () => {
    expect(needsCmdWrapper('C:\\tools\\hdc.exe', 'win32')).toBe(false);
    expect(needsCmdWrapper('C:\\tools\\hdc', 'win32')).toBe(false);
  });

  it('never wraps on POSIX, even for a file named .bat', () => {
    expect(needsCmdWrapper('/opt/tools/ohpm.bat', 'linux')).toBe(false);
    expect(needsCmdWrapper('/opt/tools/ohpm', 'darwin')).toBe(false);
  });
});

describe('escapeCmdArgument', () => {
  it('quotes a plain argument so it stays one token', () => {
    expect(escapeCmdArgument('assembleHap')).toBe('^"assembleHap^"');
  });

  it('keeps an argument with spaces as ONE token', () => {
    expect(escapeCmdArgument('product=my product')).toBe('^"product=my^ product^"');
  });

  it('caret-escapes every metacharacter', () => {
    expect(escapeCmdArgument('a|b&c')).toBe('^"a^|b^&c^"');
  });

  it('doubles trailing backslashes so they do not escape the closing quote', () => {
    expect(escapeCmdArgument('C:\\dir\\')).toBe('^"C:\\dir\\\\^"');
  });

  it('adds a second caret layer only when asked (npm-style %* shims)', () => {
    expect(escapeCmdArgument('a|b', true)).toBe('^^^"a^^^|b^^^"');
  });
});

describe('escapeCmdCommand', () => {
  it('caret-escapes spaces so an unquoted Program Files path still resolves', () => {
    expect(escapeCmdCommand('C:\\Program Files\\tools\\ohpm.bat')).toBe(
      'C:\\Program^ Files\\tools\\ohpm.bat',
    );
  });
});

describe('buildCmdWrapper', () => {
  it('invokes cmd.exe with /d /s /c and one quoted command line', () => {
    const w = buildCmdWrapper('C:\\tools\\bin\\ohpm.bat', ['install', '--all']);
    expect(w.command.toLowerCase()).toContain('cmd');
    expect(w.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(w.args).toHaveLength(4);
    expect(w.args[3]).toBe('"C:\\tools\\bin\\ohpm.bat ^"install^" ^"--all^""');
  });

  it('leaves no bare metacharacter that cmd.exe could act on', () => {
    const w = buildCmdWrapper('C:\\tools\\bin\\ohpm.bat', ['install', 'a & calc.exe']);
    const line = w.args[3]!;
    // Every & in the line is caret-escaped.
    expect(line).not.toMatch(/(^|[^^])&/);
  });

  it('refuses an argument containing a quote rather than passing it through mangled', () => {
    expect(() => buildCmdWrapper('C:\\tools\\bin\\ohpm.bat', ['a" & calc.exe & "b'])).toThrow(OniroError);
  });

  it('refuses an argument containing a newline', () => {
    expect(() => buildCmdWrapper('C:\\tools\\bin\\ohpm.bat', ['a\nb'])).toThrow(/newline/);
  });

  it('normalises forward slashes, which cmd.exe would not resolve', () => {
    const w = buildCmdWrapper('C:/tools/bin/ohpm.bat', []);
    expect(w.args[3]).toBe(isWin ? '"C:\\tools\\bin\\ohpm.bat"' : '"C:/tools/bin/ohpm.bat"');
  });
});

describe('spawnCompat', () => {
  it('is a plain spawn when no wrapper is needed', async () => {
    const child = spawnCompat(process.execPath, ['-e', 'process.stdout.write("plain")']);
    const out = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
      child.on('close', () => resolve(buf));
    });
    expect(out).toBe('plain');
  });
});

// The regression the shim exists for: before it, spawning a .cmd with
// shell:false threw `spawn EINVAL` on Node 20.12.2+ (the CVE-2024-27980 fix).
describe.skipIf(!isWin)('runProcess against a real Windows batch wrapper', () => {
  let dir: string;
  let bat: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-bat-'));
    bat = path.join(dir, 'fake-tool.cmd');

    // Model the real wrappers, not a convenient approximation. `ohpm.bat`,
    // `hvigorw.bat` and `codelinter.bat` all end in
    //     call "<inner>\tool.bat" %*
    // and the inner script hands the same `%*` to node — so an argument is
    // re-parsed by cmd.exe twice before the tool sees it. Reproducing both hops
    // is the only way this test says anything about the escaping. (A wrapper
    // using `%~1` instead would strip the quotes we rely on and re-parse the
    // bare value; nothing we can escape survives that, and no OpenHarmony
    // wrapper does it.)
    fs.writeFileSync(path.join(dir, 'print-argv.js'), 'for (const a of process.argv.slice(2)) console.log(a);\n');
    fs.writeFileSync(
      path.join(dir, 'inner.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0print-argv.js" %*\r\n`,
    );
    fs.writeFileSync(bat, '@echo off\r\nsetlocal enabledelayedexpansion\r\ncall "%~dp0inner.cmd" %*\r\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const lines = (s: string): string[] => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  it('runs the wrapper instead of throwing EINVAL', async () => {
    const r = await runProcess({ command: bat, args: ['install', '--all'] });
    expect(r.code).toBe(0);
    expect(lines(r.stdout)).toEqual(['install', '--all']);
  });

  it('passes an argument containing spaces through as one token', async () => {
    const r = await runProcess({ command: bat, args: ['product=my product'] });
    expect(lines(r.stdout)).toEqual(['product=my product']);
  });

  it('survives both %* hops with the argument list intact', async () => {
    const r = await runProcess({ command: bat, args: ['assembleHap', '-p', 'product=default'] });
    expect(lines(r.stdout)).toEqual(['assembleHap', '-p', 'product=default']);
  });

  it('does not execute injected shell metacharacters', async () => {
    const marker = path.join(dir, 'pwned.txt');
    const r = await runProcess({ command: bat, args: [`x & echo boom > ${marker}`] });
    expect(fs.existsSync(marker)).toBe(false);
    expect(lines(r.stdout)).toEqual([`x & echo boom > ${marker}`]);
  });

  it('rejects a quote rather than letting it break out of the quoted argument', async () => {
    const marker = path.join(dir, 'pwned2.txt');
    await expect(
      runProcess({ command: bat, args: [`x" & echo boom > ${marker} & "y`] }),
    ).rejects.toThrow(/quote/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('still reports a missing wrapper as a spawn failure', async () => {
    await expect(
      runProcess({ command: path.join(dir, 'no-such-tool.cmd'), args: [] }),
    ).rejects.toThrow(/Failed to spawn/);
  });
});
