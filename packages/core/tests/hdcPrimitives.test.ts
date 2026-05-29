import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { listDevices, selectDevice } from '../src/hdc/devices.js';
import { paramGet, paramSet } from '../src/hdc/param.js';
import { sendFile, recvFile } from '../src/hdc/files.js';
import { findRunningProcess, uninstallApp, forceStop } from '../src/hdc/app.js';

const isWin = process.platform === 'win32';

// A flexible fake `hdc` that returns canned output for the subcommands these
// primitives drive, and echoes argv otherwise. `targets.txt` (next to the binary)
// supplies the `list targets -v` output so individual tests can vary it.
describe.skipIf(isWin)('hdc primitives (fake hdc)', () => {
  let root: string;
  let targetsFile: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-prim-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    targetsFile = path.join(toolchains, 'targets.txt');
    fs.writeFileSync(
      targetsFile,
      'emulator-5554\tUSB\tConnected\tlocalhost\n127.0.0.1:55555\tTCP\tOffline\tremote\n',
    );
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
case "$1" in
  list) cat '${targetsFile}' 2>/dev/null; exit 0 ;;
  shell)
    case "$2" in
      *notrunning*) exit 1 ;;
      pidof*) printf '12345\\n'; exit 0 ;;
      'param get'*) printf 'paramvalue\\n'; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
for a in "$@"; do printf '%s\\n' "$a"; done
exit 0
`,
    );
    fs.chmodSync(hdc, 0o755);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ONIRO_DEVICE_SERIAL;
    delete process.env.DEVICE_SERIAL;
  });

  const config = () => staticConfig({ cmdToolsPath: root });

  it('listDevices parses the target list', async () => {
    expect(await listDevices(config())).toEqual([
      { serial: 'emulator-5554', status: 'Connected', connection: 'USB' },
      { serial: '127.0.0.1:55555', status: 'Offline', connection: 'TCP' },
    ]);
  });

  it('selectDevice returns the single connected device', async () => {
    expect(await selectDevice(config())).toBe('emulator-5554');
  });

  it('selectDevice honors an explicit serial without touching hdc', async () => {
    expect(await selectDevice(config(), 'my-serial')).toBe('my-serial');
  });

  it('selectDevice honors ONIRO_DEVICE_SERIAL', async () => {
    process.env.ONIRO_DEVICE_SERIAL = 'env-serial';
    expect(await selectDevice(config())).toBe('env-serial');
  });

  it('selectDevice throws when no device is connected', async () => {
    fs.writeFileSync(targetsFile, '[Empty]\n');
    await expect(selectDevice(config())).rejects.toThrow(/No connected device/);
  });

  it('selectDevice throws when multiple devices are connected', async () => {
    fs.writeFileSync(targetsFile, 'devA\tUSB\tConnected\ndevB\tUSB\tConnected\n');
    await expect(selectDevice(config())).rejects.toThrow(/Multiple devices/);
  });

  it('paramGet returns the trimmed value', async () => {
    expect(await paramGet(config(), 'const.product.model')).toBe('paramvalue');
  });

  it('paramSet resolves on success', async () => {
    await expect(paramSet(config(), 'ohos.startup.powerctrl', 'reboot')).resolves.toBeUndefined();
  });

  it('findRunningProcess returns the pid for a running bundle', async () => {
    expect(await findRunningProcess({ config: config(), bundle: 'com.example.app' })).toEqual({
      pid: '12345',
      name: 'com.example.app',
    });
  });

  it('findRunningProcess returns null when the bundle is not running', async () => {
    expect(await findRunningProcess({ config: config(), bundle: 'com.notrunning' })).toBeNull();
  });

  it('uninstallApp / forceStop / sendFile / recvFile resolve against a 0-exit device', async () => {
    await expect(uninstallApp({ config: config(), bundle: 'com.example.app' })).resolves.toBeUndefined();
    await expect(forceStop({ config: config(), bundle: 'com.example.app' })).resolves.toBeUndefined();
    await expect(sendFile({ config: config(), local: '/tmp/a', remote: '/data/local/tmp/a' })).resolves.toBeUndefined();
    await expect(recvFile({ config: config(), remote: '/data/local/tmp/a', local: '/tmp/a' })).resolves.toBeUndefined();
  });
});
