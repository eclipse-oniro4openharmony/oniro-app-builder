import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from './_helpers/runCli.js';
import {
  deviceRecord,
  imageRecord,
  makeFakeHarmonyOsEmulator,
  SDK_AGREEMENT,
  type FakeHarmonyOsEmulator,
} from '../../core/tests/_helpers/fakeHarmonyOsEmulator.js';

const HOS7 = 'HarmonyOS 7.0.0(26.0.0)';

describe('oniro-app emulator harmonyos', () => {
  it('--help lists the subcommands', () => {
    const r = runCli(['emulator', 'harmonyos', '--help']);
    expect(r.status).toBe(0);
    for (const sub of ['list', 'images', 'install', 'create', 'start', 'stop', 'delete', 'license']) {
      expect(r.stdout).toMatch(new RegExp(`^\\s+${sub}\\b`, 'm'));
    }
  });

  it('says where the emulator comes from when there is none', () => {
    const none = path.join(os.tmpdir(), 'oniro-no-such-tools');
    const r = runCli(['emulator', 'harmonyos', 'list'], { ONIRO_CMD_TOOLS_PATH: none, ONIRO_HARMONYOS_SDK_PATH: none, ONIRO_HARMONYOS_EMULATOR_PATH: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/No HarmonyOS emulator found\. It comes with the HarmonyOS command-line tools 26\.0\.0 or later/);
  });

  it.skipIf(process.platform === 'win32')('rejects an hdc port outside the range the emulator takes', () => {
    const r = runCli(['emulator', 'harmonyos', 'start', 'Pura 90', '--hdc-port', '5555']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('expected a port from 10000 to 16555');
  });
});

describe.skipIf(process.platform === 'win32')('oniro-app emulator harmonyos (stand-in Emulator)', () => {
  let tmp: string;
  let fake: FakeHarmonyOsEmulator;
  const cli = (...args: string[]) =>
    runCli(['emulator', 'harmonyos', ...args], {
      HOME: fake.home,
      FAKE_EMU_STATE: fake.state,
      ONIRO_HARMONYOS_EMULATOR_PATH: fake.dir,
    });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hos-emu-cli-'));
    fake = makeFakeHarmonyOsEmulator(tmp);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('shows the agreements, exits 1 until they are accepted, and accepts them on request', () => {
    let r = cli('license');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`not accepted  HarmonyOS SDK License Agreement\n              ${path.join(fake.dir, 'agreement', `${SDK_AGREEMENT}.txt`)}`);
    expect(r.stdout).toContain('not accepted  HarmonyOS Software License and Service Agreement');
    expect(r.stdout).toContain('`oniro-app emulator harmonyos license --accept`');
    expect(fake.calls()).toEqual([]);

    r = cli('license', '--accept');
    expect(r.status).toBe(0);
    expect(fake.calls()).toEqual(['-license accept']);
    expect(r.stdout).toMatch(/^accepted {6}HarmonyOS SDK License Agreement/m);
    expect(r.stdout).not.toContain('--accept');

    r = cli('license', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({ agreements: [{ name: SDK_AGREEMENT, accepted: true }, { accepted: true }] });
    expect(cli('license', '--accept', '--review').stderr).toContain('either --accept or --review');
  });

  it('lists devices and images', () => {
    fake.write('devices.json', [deviceRecord('Pura 90 HOS7', { isRunning: 'true' }), deviceRecord('Mate', { 'hw.hdc.port': '15555' })]);
    let r = cli('list');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`Pura 90 HOS7\trunning\t${HOS7}\tphone\thdc=127.0.0.1:5555\nMate\tstopped\t${HOS7}\tphone\thdc=127.0.0.1:15555\n`);
    expect(JSON.parse(cli('list', '--json').stdout)).toHaveLength(2);

    fake.write('images.json', [
      imageRecord(HOS7, 'phone', { downloaded: 'true' }),
      imageRecord('HarmonyOS 6.1.1(24)', 'phone', { downloaded: 'true', upgradable: 'true', SoftWareVersion: '6.1.0.126' }),
      imageRecord('HarmonyOS 6.1.0(23)', 'phone', { SoftWareVersion: '6.1.0.115' }),
    ]);
    r = cli('images', '--device-type', 'phone');
    expect(r.stdout.split('\n')).toEqual([
      `*  ${HOS7}    phone          7.0.0.107`,
      '^  HarmonyOS 6.1.1(24)        phone          6.1.0.126',
      '   HarmonyOS 6.1.0(23)        phone          6.1.0.115',
      '',
    ]);
    expect(fake.calls().at(-1)).toBe('-imageList -deviceType phone');
  });

  it('downloads an image once the SDK licence is accepted, and skips one already downloaded', () => {
    fake.write('images.json', [imageRecord(HOS7, 'phone'), imageRecord('HarmonyOS 6.1.1(24)', 'phone', { downloaded: 'true' })]);
    fake.write('images-after-install.json', [imageRecord(HOS7, 'phone', { downloaded: 'true' })]);
    let r = cli('install', '26');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/needs HarmonyOS SDK License Agreement .* accepted before it downloads an image/);
    expect(fake.calls().some((c) => c.startsWith('-install'))).toBe(false);

    fake.accept(SDK_AGREEMENT);
    r = cli('install', '26');
    expect(r.status).toBe(0);
    expect(fake.calls()).toContain(`-install -deviceType phone -osVersion ${HOS7}`);
    expect(r.stderr).toContain('create <name> --image 26');

    r = cli('install', '6.1.1');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('HarmonyOS 6.1.1(24) (phone) is already downloaded.');
    expect(cli('install', '27').stderr).toContain(`No HarmonyOS phone image matches "27". Available: ${HOS7}, HarmonyOS 6.1.1(24).`);
  });

  it('creates a device only on a downloaded image, naming the install to run', () => {
    let r = cli('create', 'Test 26', '--image', '26');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('No downloaded HarmonyOS emulator image for device type "phone".');
    expect(r.stderr).toContain('`oniro-app emulator harmonyos install "26" --device-type "phone"`');

    fake.write('images-downloaded.json', [imageRecord(HOS7, 'phone', { downloaded: 'true' })]);
    fake.write('devices-after-create.json', [deviceRecord('Test 26')]);
    r = cli('create', 'Test 26', '--image', '26', '--memory', '6', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ name: 'Test 26', api: 26 });
    expect(fake.calls()).toContain(`-create Test 26 -deviceType phone -osVersion ${HOS7} -memory 6`);
    expect(cli('create', 'X', '--image', '26', '--memory', '64').stderr).toContain('expected a whole number of GB from 2 to 32');
  });
});
