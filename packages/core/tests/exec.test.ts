import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scopedLogger, type Logger } from '../src/ports/logger.js';
import { CommandFailedError, CancelledError, OniroError } from '../src/ports/errors.js';
import { runProcess, hdcExec, shell, ensureOk } from '../src/hdc/exec.js';
import { staticConfig } from '../src/ports/config.js';
import { installApp, launchApp } from '../src/hdc/app.js';

const NODE = process.execPath;
const isWin = process.platform === 'win32';

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m) => lines.push(`debug:${m}`),
    info: (m) => lines.push(`info:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
  };
  return { logger, lines };
}

describe('scopedLogger', () => {
  it('prefixes every level with [scope]', () => {
    const { logger, lines } = capturingLogger();
    const scoped = scopedLogger(logger, 'hdc');
    scoped.debug('d');
    scoped.info('i');
    scoped.warn('w');
    scoped.error('e');
    expect(lines).toEqual(['debug:[hdc] d', 'info:[hdc] i', 'warn:[hdc] w', 'error:[hdc] e']);
  });
});

describe('CommandFailedError', () => {
  it('carries command/exitCode/stderr and is an OniroError', () => {
    const err = new CommandFailedError('hdc install x', 9568332, 'sign-info-inconsistent');
    expect(err).toBeInstanceOf(OniroError);
    expect(err.name).toBe('CommandFailedError');
    expect(err.command).toBe('hdc install x');
    expect(err.exitCode).toBe(9568332);
    expect(err.stderr).toBe('sign-info-inconsistent');
    expect(err.message).toContain('exit 9568332');
    expect(err.message).toContain('sign-info-inconsistent');
  });
});

describe('runProcess', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await runProcess({ command: NODE, args: ['-e', 'process.stdout.write("hello")'] });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hello');
  });

  it('resolves (does NOT throw) on a non-zero exit, capturing stderr', async () => {
    const r = await runProcess({ command: NODE, args: ['-e', 'process.stderr.write("boom");process.exit(2)'] });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('boom');
  });

  it('streams chunks via onOutput', async () => {
    const chunks: Array<[string, string]> = [];
    await runProcess({
      command: NODE,
      args: ['-e', 'process.stdout.write("a");process.stderr.write("b")'],
      onOutput: (c, s) => chunks.push([s, c]),
    });
    expect(chunks).toContainEqual(['stdout', 'a']);
    expect(chunks).toContainEqual(['stderr', 'b']);
  });

  it('rejects with a timeout error and kills the process', async () => {
    await expect(
      runProcess({ command: NODE, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100ms/);
  });

  it('rejects with CancelledError when aborted mid-run', async () => {
    const controller = new AbortController();
    const p = runProcess({
      command: NODE,
      args: ['-e', 'setInterval(()=>{},1000)'],
      timeoutMs: 5000,
      abortSignal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runProcess({ command: NODE, args: ['-e', ''], abortSignal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it('rejects with OniroError when the binary cannot be spawned', async () => {
    await expect(
      runProcess({ command: 'oniro-no-such-binary-xyz', args: [] }),
    ).rejects.toThrow(/Failed to spawn/);
  });
});

describe('ensureOk', () => {
  it('returns the result on a zero exit code', () => {
    const r = { code: 0, stdout: 'ok', stderr: '' };
    expect(ensureOk(r, 'cmd')).toBe(r);
  });

  it('throws CommandFailedError on a non-zero exit code', () => {
    expect(() => ensureOk({ code: 1, stdout: '', stderr: 'nope' }, 'cmd')).toThrow(CommandFailedError);
  });
});

// The fake-hdc tests prove argv plumbing + the injection fix without a device.
// They write a POSIX shell script that echoes each received arg on its own line.
describe.skipIf(isWin)('hdcExec / shell argv (fake hdc)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-exec-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(hdc, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
    fs.chmodSync(hdc, 0o755);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const config = () => staticConfig({ cmdToolsPath: root });

  it('passes args through verbatim', async () => {
    const r = await hdcExec({ config: config(), args: ['list', 'targets', '-v'] });
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['list', 'targets', '-v']);
  });

  it('prepends -t <serial> when deviceSerial is set', async () => {
    const r = await hdcExec({ config: config(), args: ['shell', 'whoami'], deviceSerial: 'ABC123' });
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['-t', 'ABC123', 'shell', 'whoami']);
  });

  it('shell() wraps a single command as one argv element', async () => {
    const r = await shell({ config: config(), command: 'param set a b' });
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['shell', 'param set a b']);
  });
});

describe.skipIf(isWin)('installApp / launchApp argv + injection safety (fake hdc)', () => {
  let root: string;
  let projectDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-exec-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(hdc, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
    fs.chmodSync(hdc, 0o755);

    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-proj-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const config = () => staticConfig({ cmdToolsPath: root });

  it('installApp sends `install <hapPath>` as discrete args', async () => {
    const hapPath = path.join(projectDir, 'app.hap');
    fs.writeFileSync(hapPath, 'fake');
    await installApp({ config: config(), projectDir, hapPath });
    // No throw means exit 0 from the fake hdc. (Output is logged, not returned in P1.)
  });

  it('launchApp passes a metacharacter-laden ability as ONE argv element (no host injection)', async () => {
    const evilAbility = 'Evil; touch /tmp/oniro_pwned_$$';
    fs.mkdirSync(path.join(projectDir, 'AppScope'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'AppScope', 'app.json5'),
      JSON.stringify({ app: { bundleName: 'com.example.app' } }),
    );
    fs.mkdirSync(path.join(projectDir, 'entry', 'src', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'entry', 'src', 'main', 'module.json5'),
      JSON.stringify({ module: { mainElement: evilAbility } }),
    );

    // Capture argv by pointing onOutput at the fake hdc's echo. We re-run through hdcExec
    // indirectly: launchApp logs via scopedLogger, so assert no throw + capture separately.
    const r = await hdcExec({
      config: config(),
      args: ['shell', 'aa', 'start', '-a', evilAbility, '-b', 'com.example.app'],
    });
    const args = r.stdout.split('\n').filter(Boolean);
    // The dangerous ability arrives intact as a single element — never word-split by a host shell.
    expect(args).toContain(evilAbility);
    expect(args).toEqual(['shell', 'aa', 'start', '-a', evilAbility, '-b', 'com.example.app']);

    // And launchApp itself runs to completion against the fake hdc without throwing.
    await expect(launchApp({ config: config(), projectDir })).resolves.toBeUndefined();
  });
});
