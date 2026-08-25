import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { setHilogLevel, streamHilog } from '../src/hdc/hilog.js';
import { listRunningProcesses } from '../src/hdc/app.js';

const isWin = process.platform === 'win32';

// `getHdcPath` resolves `hdc.bat`/`hdc.cmd` as candidates, and an `hdcPath`
// override is explicitly documented as a place to point at a wrapper script
// (e.g. an SSH-tunnel proxy hdc). These three call sites stream from a
// long-lived child and so spawn hdc directly rather than through `runProcess`,
// which means they need the same batch-wrapper handling. `spawn EINVAL` is
// thrown synchronously, so missing one crashes the process rather than
// surfacing as an 'error' event.
describe.skipIf(!isWin)('hdc streaming call sites against a Windows batch wrapper', () => {
  let dir: string;
  let hdc: string;

  /** Write a fake `hdc.cmd` wrapper that runs `script` as the hdc it shells out to. */
  const fakeHdc = (script: string): void => {
    fs.writeFileSync(path.join(dir, 'fake-hdc.js'), script);
    fs.writeFileSync(hdc, `@echo off\r\n"${process.execPath}" "%~dp0fake-hdc.js" %*\r\n`);
  };

  /** Drain a streaming child's stdout to completion. */
  const drain = (child: { stdout: NodeJS.ReadableStream | null; on: (e: string, f: () => void) => unknown }): Promise<string> =>
    new Promise<string>((resolve) => {
      let buf = '';
      child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
      child.on('close', () => resolve(buf));
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hdcbat-'));
    hdc = path.join(dir, 'hdc.cmd');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('listRunningProcesses reads track-jpid through the wrapper', async () => {
    fakeHdc('console.log("1234 com.example.app");\n');
    const config = staticConfig({ hdcPath: hdc });
    const pid = await listRunningProcesses(config, { targetProcessName: 'com.example.app', timeoutMs: 8000 });
    expect(pid).toBe('1234');
  });

  it('streamHilog pipes the device log through the wrapper', async () => {
    fakeHdc('console.log("01-01 00:00:00.000  1  2 I Tag: hello");\n');
    const out = await drain(streamHilog({ config: staticConfig({ hdcPath: hdc }) }));
    expect(out.trim()).toBe('01-01 00:00:00.000  1  2 I Tag: hello');
  });

  it('streamHilog forwards its args intact across the wrapper', async () => {
    fakeHdc('console.log(process.argv.slice(2).join("|"));\n');
    const out = await drain(
      streamHilog({
        config: staticConfig({ hdcPath: hdc }),
        deviceSerial: 'ABC123',
        processId: '1234',
        domain: '0xD003900',
      }),
    );
    expect(out.trim()).toBe('-t|ABC123|shell|hilog|-P|1234|-D|0xD003900');
  });

  it('setHilogLevel resolves when the wrapper exits 0', async () => {
    fakeHdc('process.exit(0);\n');
    await expect(setHilogLevel({ config: staticConfig({ hdcPath: hdc }), level: 'DEBUG' })).resolves.toBeUndefined();
  });

  it('setHilogLevel rejects with the wrapper stderr on a non-zero exit', async () => {
    fakeHdc('console.error("[Fail]device not founded"); process.exit(1);\n');
    await expect(
      setHilogLevel({ config: staticConfig({ hdcPath: hdc }), level: 'DEBUG' }),
    ).rejects.toThrow(/device not founded/);
  });
});
