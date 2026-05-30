import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { waitForBundle, waitForBoot } from '../src/hdc/lifecycle.js';

const isWin = process.platform === 'win32';

// A fake `hdc` that records every `tconn <addr>` to a log file and otherwise
// answers pidof/echo so the wait resolves on the first poll. It strips an
// optional `-t <serial>` prefix first, mirroring how hdcExec targets a device.
// Regression cover for: a TCP target (emulator) must be reconnected with
// `hdc tconn` across a reboot, or the post-reboot wait polls a dead socket.
describe.skipIf(isWin)('reboot wait reconnects TCP targets (fake hdc)', () => {
  let root: string;
  let tconnLog: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-reconnect-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    tconnLog = path.join(toolchains, 'tconn.log');
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
if [ "$1" = "-t" ]; then shift 2; fi
case "$1" in
  tconn) printf '%s\\n' "$2" >> '${tconnLog}'; exit 0 ;;
  shell)
    case "$2" in
      pidof*) printf '12345\\n'; exit 0 ;;
      echo*) printf 'oniro_ping\\n'; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
exit 0
`,
    );
    fs.chmodSync(hdc, 0o755);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const config = () => staticConfig({ cmdToolsPath: root });
  const tconnCalls = (): string[] =>
    fs.existsSync(tconnLog) ? fs.readFileSync(tconnLog, 'utf8').trim().split('\n').filter(Boolean) : [];

  it('waitForBundle issues hdc tconn for a TCP serial before probing', async () => {
    await expect(
      waitForBundle({ config: config(), bundle: 'com.example.app', deviceSerial: '127.0.0.1:55555', timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
    expect(tconnCalls()).toContain('127.0.0.1:55555');
  });

  it('waitForBundle does NOT reconnect a USB serial (no host:port)', async () => {
    await expect(
      waitForBundle({ config: config(), bundle: 'com.example.app', deviceSerial: 'emulator-5554', timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
    expect(tconnCalls()).toEqual([]);
  });

  it('waitForBundle does NOT reconnect when no serial is given', async () => {
    await expect(
      waitForBundle({ config: config(), bundle: 'com.example.app', timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
    expect(tconnCalls()).toEqual([]);
  });

  it('waitForBoot reconnects a TCP serial before the reachability probe', async () => {
    await expect(
      waitForBoot({ config: config(), untilPidOf: 'com.ohos.launcher', deviceSerial: '127.0.0.1:55555', timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
    expect(tconnCalls()).toContain('127.0.0.1:55555');
  });
});
