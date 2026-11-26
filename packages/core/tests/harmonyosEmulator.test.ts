import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acceptHarmonyOsEmulatorLicenses,
  checkHarmonyOsEmulatorHost,
  createHarmonyOsEmulatorDevice,
  deleteHarmonyOsEmulatorDevice,
  findHarmonyOsEmulator,
  harmonyOsEmulatorAddress,
  harmonyOsEmulatorEnv,
  harmonyOsEmulatorStateFile,
  HarmonyOsEmulatorLicenseError,
  installHarmonyOsEmulatorImage,
  listHarmonyOsEmulatorDevices,
  listHarmonyOsEmulatorImages,
  parseHarmonyOsEmulatorDevices,
  parseHarmonyOsEmulatorImages,
  parseHarmonyOsVersion,
  readHarmonyOsEmulatorLicenses,
  requireHarmonyOsEmulator,
  requireHarmonyOsEmulatorLicenses,
  resolveHarmonyOsEmulatorImage,
  startHarmonyOsEmulator,
  stopHarmonyOsEmulator,
  type HarmonyOsEmulator,
  type HarmonyOsEmulatorImage,
} from '../src/harmonyos/emulator.js';
import { checkHarmonyOsEmulator, type DoctorVersions } from '../src/doctor/doctor.js';
import { staticConfig } from '../src/ports/config.js';
import type { ProgressUpdate } from '../src/ports/progress.js';
import {
  deviceRecord,
  imageRecord,
  makeFakeHarmonyOsEmulator,
  SDK_AGREEMENT,
  SERVICE_AGREEMENT,
  type FakeHarmonyOsEmulator,
} from './_helpers/fakeHarmonyOsEmulator.js';

const isWin = process.platform === 'win32';
const HOS7 = 'HarmonyOS 7.0.0(26.0.0)';
const HOS611 = 'HarmonyOS 6.1.1(24)';

describe('HarmonyOS emulator output', () => {
  it('reads release names', () => {
    expect(parseHarmonyOsVersion(HOS7)).toEqual({ release: '7.0.0', api: 26 });
    expect(parseHarmonyOsVersion(HOS611)).toEqual({ release: '6.1.1', api: 24 });
    expect(parseHarmonyOsVersion('HarmonyOS 6.0.1(21) Beta1')).toEqual({ release: '6.0.1', api: 21, stage: 'Beta1' });
    expect(parseHarmonyOsVersion('OpenHarmony 6.0')).toEqual({});
  });

  it('reads -list -details, and its empty list', () => {
    const json = JSON.stringify([deviceRecord('Pura 90 HOS7', { isRunning: 'true' }), deviceRecord('Mate', { 'hw.hdc.port': '15555', 'os.osVersion': HOS611, 'os.apiVersion': '24' })], null, 4);
    expect(parseHarmonyOsEmulatorDevices(json)).toEqual([
      {
        name: 'Pura 90 HOS7',
        running: true,
        deviceType: 'phone',
        osVersion: HOS7,
        release: '7.0.0',
        api: 26,
        softwareVersion: '7.0.0.107',
        instancePath: '/home/u/.Huawei/Emulator/deployed/Pura 90 HOS7',
        imageRoot: '/home/u/hmos-sdk',
        imageSubPath: 'system-image/HarmonyOS-7.0.0/phone_all_x86/',
        memoryMb: 4096,
        cpus: 4,
        screen: { width: 1256, height: 2760, density: 560 },
        productModel: 'Pura 90 Pro',
      },
      expect.objectContaining({ name: 'Mate', running: false, api: 24, release: '6.1.1', hdcPort: 15555 }),
    ]);
    expect(parseHarmonyOsEmulatorDevices('[Empty]\n')).toEqual([]);
    // Log lines after the array, brackets in values.
    const noisy = `${JSON.stringify([deviceRecord('A [1]')])}\n[INFO] done]\n`;
    expect(parseHarmonyOsEmulatorDevices(noisy).map((d) => d.name)).toEqual(['A [1]']);
    expect(() => parseHarmonyOsEmulatorDevices('Segmentation fault')).toThrow(/Could not read the HarmonyOS emulator's device list/);
  });

  it('reads -imageList, and its no-match line', () => {
    const json = JSON.stringify([
      imageRecord(HOS7, 'phone', { downloaded: 'true' }),
      imageRecord('HarmonyOS 6.0.1(21) Beta1', 'tablet', { SoftWareVersion: '6.0.0.99', upgradable: 'true' }),
    ]);
    expect(parseHarmonyOsEmulatorImages(json)).toEqual([
      { osVersion: HOS7, deviceType: 'phone', downloaded: true, upgradable: false, release: '7.0.0', api: 26, softwareVersion: '7.0.0.107', releaseType: 'Release' },
      expect.objectContaining({ deviceType: 'tablet', api: 21, stage: 'Beta1', downloaded: false, upgradable: true }),
    ]);
    expect(parseHarmonyOsEmulatorImages('No images matching the criteria were found.\n')).toEqual([]);
  });

  it('gives the hdc address, the default port unless the device or the run sets one', () => {
    expect(harmonyOsEmulatorAddress({})).toBe('127.0.0.1:5555');
    expect(harmonyOsEmulatorAddress({ hdcPort: 15555 })).toBe('127.0.0.1:15555');
    expect(harmonyOsEmulatorAddress({ hdcPort: 15555 }, 12000)).toBe('127.0.0.1:12000');
  });

  it('turns NVIDIA vsync off unless the caller set it', () => {
    expect(harmonyOsEmulatorEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', __GL_SYNC_TO_VBLANK: '0' });
    expect(harmonyOsEmulatorEnv({ __GL_SYNC_TO_VBLANK: '1' })).toEqual({ __GL_SYNC_TO_VBLANK: '1' });
  });
});

describe('resolveHarmonyOsEmulatorImage', () => {
  const images = parseHarmonyOsEmulatorImages(
    JSON.stringify([
      imageRecord(HOS7, 'phone'),
      imageRecord(HOS611, 'phone', { SoftWareVersion: '6.1.0.126' }),
      imageRecord('HarmonyOS 6.1.1(24) Beta2', 'phone', { SoftWareVersion: '6.1.0.200' }),
      imageRecord(HOS7, '2in1 Foldable'),
    ]),
  );
  const pick = (q: string, type = 'phone'): HarmonyOsEmulatorImage => resolveHarmonyOsEmulatorImage(images, q, type);

  it('takes the API level, the release or the full name', () => {
    expect(pick('26').osVersion).toBe(HOS7);
    expect(pick('26.0.0').osVersion).toBe(HOS7);
    expect(pick('7.0.0').osVersion).toBe(HOS7);
    expect(pick('harmonyos  7.0.0(26.0.0)').osVersion).toBe(HOS7);
    expect(pick('26', '2in1 foldable').deviceType).toBe('2in1 Foldable');
  });

  it('prefers the release image to a beta of the same API level', () => {
    expect(pick('24').osVersion).toBe(HOS611);
    expect(pick('HarmonyOS 6.1.1(24) Beta2').softwareVersion).toBe('6.1.0.200');
  });

  it('lists what there is when nothing matches', () => {
    expect(() => pick('27')).toThrow(`No HarmonyOS phone image matches "27". Available: ${HOS7}, ${HOS611}, HarmonyOS 6.1.1(24) Beta2.`);
    expect(() => pick('26', 'car')).toThrow('No HarmonyOS emulator image for device type "car". Device types: phone, 2in1 Foldable.');
  });
});

describe('the HarmonyOS emulator on disk', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hos-emu-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('is found in the configured place, the command-line tools, or next to the HarmonyOS SDK', () => {
    const fake = makeFakeHarmonyOsEmulator(path.join(tmp, 'clt26'));
    const none = path.join(tmp, 'none');
    const cfg = (values: Record<string, string>) => staticConfig({ cmdToolsPath: none, harmonyosSdkPath: none, ...values });
    for (const configured of [fake.binary, fake.dir, fake.root]) {
      expect(findHarmonyOsEmulator(cfg({ harmonyosEmulatorPath: configured }))).toEqual({
        binary: fake.binary,
        dir: fake.dir,
        version: '26.0.0.400',
        source: 'configured',
      });
    }
    expect(findHarmonyOsEmulator(cfg({ cmdToolsPath: fake.root }))).toMatchObject({ binary: fake.binary, source: 'cmdtools' });
    // A configured path without one falls through to the others.
    expect(findHarmonyOsEmulator(cfg({ harmonyosEmulatorPath: none, cmdToolsPath: fake.root }))).toMatchObject({ source: 'cmdtools' });
    // ONIRO_HARMONYOS_SDK_PATH at the tools' sdk/: the emulator sits beside it.
    fs.mkdirSync(path.join(fake.root, 'sdk', 'default', 'openharmony'), { recursive: true });
    fs.writeFileSync(
      path.join(fake.root, 'sdk', 'default', 'sdk-pkg.json'),
      JSON.stringify({ data: { displayName: 'HarmonyOS 26.0.0', platformVersion: '26.0.0', apiVersion: '26' } }),
    );
    expect(findHarmonyOsEmulator(cfg({ harmonyosSdkPath: path.join(fake.root, 'sdk') }))).toMatchObject({ source: 'harmonyos-sdk' });
    expect(findHarmonyOsEmulator(cfg({}))).toBeNull();
    expect(() => requireHarmonyOsEmulator(cfg({}))).toThrow(/No HarmonyOS emulator found.*26\.0\.0 or later.*ONIRO_HARMONYOS_EMULATOR_PATH/);
  });

  it("reads Huawei's agreements and whether each is accepted", () => {
    const fake = makeFakeHarmonyOsEmulator(tmp);
    const emulator: HarmonyOsEmulator = { binary: fake.binary, dir: fake.dir, version: '26.0.0.400', source: 'configured' };
    const stateFile = path.join(fake.home, 'Library', 'Caches', 'Huawei', 'Emulator26.0', '.emu_config');
    expect(harmonyOsEmulatorStateFile(emulator, fake.home, 'linux')).toBe(stateFile);
    expect(harmonyOsEmulatorStateFile(emulator, fake.home, 'win32')).toBeUndefined();
    expect(harmonyOsEmulatorStateFile({}, fake.home, 'linux')).toBeUndefined();

    const read = () => readHarmonyOsEmulatorLicenses(emulator, { home: fake.home, platform: 'linux' });
    expect(read()).toEqual({
      stateFile,
      agreements: [
        { name: SDK_AGREEMENT, title: 'HarmonyOS SDK License Agreement', file: path.join(fake.dir, 'agreement', `${SDK_AGREEMENT}.txt`), accepted: false },
        {
          name: SERVICE_AGREEMENT,
          title: 'HarmonyOS Software License and Service Agreement',
          file: path.join(fake.dir, 'agreement', `${SERVICE_AGREEMENT}.txt`),
          accepted: false,
        },
      ],
    });
    fake.accept(SDK_AGREEMENT);
    fs.appendFileSync(stateFile, `${SERVICE_AGREEMENT}:disagree\nimagePath:/x\n`);
    expect(read().agreements.map((a) => a.accepted)).toEqual([true, false]);
    expect(readHarmonyOsEmulatorLicenses(emulator, { home: fake.home, platform: 'win32' }).agreements.map((a) => a.accepted)).toEqual([undefined, undefined]);

    // Installing needs the SDK licence, starting the service agreement.
    expect(() => requireHarmonyOsEmulatorLicenses(emulator, 'install', { home: fake.home, platform: 'linux' })).not.toThrow();
    const err = (() => {
      try {
        requireHarmonyOsEmulatorLicenses(emulator, 'start', { home: fake.home, platform: 'linux' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(HarmonyOsEmulatorLicenseError);
    expect((err as Error).message).toMatch(
      /needs HarmonyOS Software License and Service Agreement \(.*Service_Agreement\.txt\) accepted before it starts a device\. .*license --accept.*license --review/,
    );
  });

  it('checks what the emulator needs of a Linux host', () => {
    const dev = path.join(tmp, 'dev');
    fs.mkdirSync(dev);
    expect(checkHarmonyOsEmulatorHost({ devDir: dev, platform: 'darwin' })).toBeNull();
    let host = checkHarmonyOsEmulatorHost({ devDir: dev, platform: 'linux' })!;
    expect(host.kvm).toMatchObject({ ok: false, detail: `${path.join(dev, 'kvm')} does not exist`, fix: expect.stringContaining('VT-x') });
    expect(host.gpu).toMatchObject({ ok: false, detail: `no GPU render node in ${path.join(dev, 'dri')}` });
    fs.writeFileSync(path.join(dev, 'kvm'), '');
    fs.mkdirSync(path.join(dev, 'dri'));
    fs.writeFileSync(path.join(dev, 'dri', 'card0'), '');
    fs.writeFileSync(path.join(dev, 'dri', 'renderD128'), '');
    host = checkHarmonyOsEmulatorHost({ devDir: dev, platform: 'linux' })!;
    expect(host.kvm.ok).toBe(true);
    expect(host.gpu).toEqual({ ok: true, detail: `${path.join(dev, 'dri', 'renderD128')} is accessible` });
    if (!isWin && process.getuid?.() !== 0) {
      fs.chmodSync(path.join(dev, 'kvm'), 0);
      fs.chmodSync(path.join(dev, 'dri', 'renderD128'), 0);
      host = checkHarmonyOsEmulatorHost({ devDir: dev, platform: 'linux' })!;
      expect(host.kvm).toMatchObject({ ok: false, fix: 'sudo usermod -aG kvm $USER, then log in again.' });
      expect(host.gpu).toMatchObject({ ok: false, fix: 'sudo usermod -aG render $USER, then log in again.' });
    }
  });

  it('is reported by doctor: skipped when absent, a warning while the agreements are not accepted', () => {
    const none = path.join(tmp, 'none');
    const versions: DoctorVersions = { node: '20' };
    expect(checkHarmonyOsEmulator(staticConfig({ cmdToolsPath: none, harmonyosSdkPath: none }), versions)).toMatchObject({
      id: 'hos-emulator',
      status: 'skip',
    });
    const fake = makeFakeHarmonyOsEmulator(path.join(tmp, 'clt26'));
    const dev = path.join(tmp, 'dev');
    fs.mkdirSync(path.join(dev, 'dri'), { recursive: true });
    fs.writeFileSync(path.join(dev, 'kvm'), '');
    fs.writeFileSync(path.join(dev, 'dri', 'renderD128'), '');
    const config = staticConfig({ cmdToolsPath: fake.root, harmonyosSdkPath: none });
    const check = () => checkHarmonyOsEmulator(config, versions, { devDir: dev, platform: 'linux', home: fake.home });
    expect(check()).toMatchObject({
      status: 'warn',
      detail: `Emulator 26.0.0.400 at ${fake.dir}: HarmonyOS SDK License Agreement and HarmonyOS Software License and Service Agreement not accepted`,
      fix: expect.stringContaining('oniro-app emulator harmonyos license --accept'),
    });
    expect(versions.harmonyosEmulator).toBe('26.0.0.400');
    fake.accept(SDK_AGREEMENT, SERVICE_AGREEMENT);
    expect(check()).toEqual({
      id: 'hos-emulator',
      status: 'ok',
      detail: `Emulator 26.0.0.400 at ${fake.dir}, KVM and GPU accessible, agreements accepted`,
    });
    fs.rmSync(path.join(dev, 'kvm'));
    expect(check()).toMatchObject({ status: 'warn', detail: expect.stringContaining('kvm does not exist') });
  });
});

describe.skipIf(isWin)('driving the HarmonyOS emulator (stand-in Emulator)', () => {
  let tmp: string;
  let fake: FakeHarmonyOsEmulator;
  let emulator: HarmonyOsEmulator;
  const children: number[] = [];
  const run = () => ({ env: fake.env, home: fake.home });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hos-emu-run-'));
    fake = makeFakeHarmonyOsEmulator(tmp);
    emulator = { binary: fake.binary, dir: fake.dir, version: '26.0.0.400', source: 'cmdtools' };
  });
  afterEach(() => {
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists devices and images', async () => {
    expect(await listHarmonyOsEmulatorDevices(emulator, run())).toEqual([]);
    fake.write('devices.json', [deviceRecord('Pura 90 HOS7')]);
    expect((await listHarmonyOsEmulatorDevices(emulator, run())).map((d) => d.name)).toEqual(['Pura 90 HOS7']);
    fake.write('images.json', [imageRecord(HOS7, 'phone')]);
    expect(await listHarmonyOsEmulatorImages(emulator, { ...run(), deviceType: 'phone', downloaded: true })).toEqual([]);
    expect(await listHarmonyOsEmulatorImages(emulator, { ...run(), deviceType: 'phone', httpProxy: 'http://proxy:3128' })).toHaveLength(1);
    expect(fake.calls()).toEqual([
      '-list -details',
      '-list -details',
      '-imageList -deviceType phone -downloaded true',
      '-imageList -deviceType phone -http_proxy http://proxy:3128',
    ]);
  });

  it('downloads an image only with the SDK licence accepted, reporting progress', async () => {
    const image = { osVersion: HOS7, deviceType: 'phone' };
    fake.write('images-after-install.json', [imageRecord(HOS7, 'phone', { downloaded: 'true' })]);
    const install = (progress?: { report(u: ProgressUpdate): void }) =>
      installHarmonyOsEmulatorImage({ emulator, image, ...run(), ...(progress ? { progress } : {}) });

    await expect(install()).rejects.toThrow(HarmonyOsEmulatorLicenseError);
    // Refused before the emulator ran: it would only have prompted.
    expect(fake.calls()).toEqual([]);

    await acceptHarmonyOsEmulatorLicenses(emulator, run());
    const updates: ProgressUpdate[] = [];
    await install({ report: (u) => updates.push(u) });
    expect(updates.map((u) => u.increment)).toEqual([12, 38, 50]);
    expect(updates.at(-1)!.message).toBe(`Downloading ${HOS7} (phone): 100% of 2 MB`);
    expect(fake.calls()).toEqual(['-license accept', `-install -deviceType phone -osVersion ${HOS7}`, `-imageList -deviceType phone -downloaded true`]);
  });

  it('reports an install the emulator declined while exiting 0', async () => {
    const image = { osVersion: HOS7, deviceType: 'phone' };
    // The licence was accepted elsewhere than the state file says: the emulator prompts.
    await expect(
      installHarmonyOsEmulatorImage({ emulator: { ...emulator, version: undefined }, image, ...run() }),
    ).rejects.toThrow(HarmonyOsEmulatorLicenseError);
    // It says it downloaded, but the image is not there.
    fake.accept(SDK_AGREEMENT);
    await expect(installHarmonyOsEmulatorImage({ emulator, image, ...run() })).rejects.toThrow(
      `Emulator -install did not download ${HOS7} (phone)`,
    );
  });

  it('creates and deletes devices', async () => {
    const image = { osVersion: HOS7, deviceType: 'phone' };
    await expect(createHarmonyOsEmulatorDevice({ emulator, name: 'bad/name', image, ...run() })).rejects.toThrow(/Invalid HarmonyOS emulator device name/);
    fake.write('devices-after-create.json', [deviceRecord('Test 26')]);
    const device = await createHarmonyOsEmulatorDevice({ emulator, name: 'Test 26', image, memoryGb: 6, storageGb: 8, ...run() });
    expect(device).toMatchObject({ name: 'Test 26', api: 26, running: false });
    expect(fake.calls()).toContain(`-create Test 26 -deviceType phone -osVersion ${HOS7} -memory 6 -storage 8`);
    await expect(createHarmonyOsEmulatorDevice({ emulator, name: 'Test 26', image, ...run() })).rejects.toThrow('already exists');

    fake.write('devices.json', [deviceRecord('Test 26', { isRunning: 'true' })]);
    await expect(deleteHarmonyOsEmulatorDevice({ emulator, name: 'Test 26', ...run() })).rejects.toThrow(/is running; stop it first/);
    fake.write('devices.json', [deviceRecord('Test 26')]);
    fake.write('devices-after-delete.json', '[Empty]');
    await deleteHarmonyOsEmulatorDevice({ emulator, name: 'Test 26', ...run() });
    expect(fake.calls().at(-1)).toBe('-delete Test 26 -force');
    await expect(deleteHarmonyOsEmulatorDevice({ emulator, name: 'Test 26', ...run() })).rejects.toThrow(
      'No HarmonyOS emulator device named "Test 26". There are none',
    );
  });

  it('starts a device detached, with vsync off, and waits for its boot over hdc', async () => {
    fake.write('devices.json', [deviceRecord('Pura 90 HOS7', { instancePath: path.join(tmp, 'deployed', 'Pura 90 HOS7') })]);
    const hdc = path.join(tmp, 'hdc');
    fs.writeFileSync(hdc, '#!/bin/sh\necho "$*" >> "$(dirname "$0")/hdc.log"\ncase "$*" in *bootevent*) echo true ;; esac\n', { mode: 0o755 });
    const config = staticConfig({ hdcPath: hdc });
    const opts = { config, emulator, name: 'Pura 90 HOS7', settleMs: 300, pollIntervalMs: 100, ...run() };

    await expect(startHarmonyOsEmulator(opts)).rejects.toThrow(HarmonyOsEmulatorLicenseError);
    fake.accept(SERVICE_AGREEMENT);
    const started = await startHarmonyOsEmulator({ ...opts, headless: true, bootMode: 'coldboot', hdcPort: 15555, waitReadySeconds: 10 });
    children.push(started.pid!);
    expect(started).toMatchObject({
      name: 'Pura 90 HOS7',
      address: '127.0.0.1:15555',
      alreadyRunning: false,
      ready: true,
      logFile: path.join(tmp, 'deployed', 'Pura 90 HOS7', 'Log', 'oniro-app-start.log'),
    });
    expect(fake.calls().at(-1)).toBe('-start Pura 90 HOS7 -noWindow -bootMode coldboot -hdcPort 15555');
    expect(fs.readFileSync(path.join(fake.state, 'vsync'), 'utf8').trim()).toBe('0');
    expect(fs.readFileSync(path.join(tmp, 'hdc.log'), 'utf8')).toMatch(/tconn 127\.0\.0\.1:15555/);
    // The process outlives the call.
    expect(() => process.kill(started.pid!, 0)).not.toThrow();

    // A running device is left alone.
    fake.write('devices.json', [deviceRecord('Pura 90 HOS7', { isRunning: 'true' })]);
    const again = await startHarmonyOsEmulator(opts);
    expect(again).toEqual({ name: 'Pura 90 HOS7', address: '127.0.0.1:5555', alreadyRunning: true });
    expect(fake.calls().filter((c) => c.startsWith('-start'))).toHaveLength(1);

    // An hdc port only applies to a launch: a running device is reached where hdc lists it.
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    expect(await startHarmonyOsEmulator({ ...opts, hdcPort: 12000, logger })).toMatchObject({ address: '127.0.0.1:5555' });
    expect(warnings).toEqual([expect.stringContaining('hdc lists nothing at 127.0.0.1:12000')]);
    fs.writeFileSync(hdc, '#!/bin/sh\ncase "$*" in "list targets"*) printf "127.0.0.1:12000\\tTCP\\tConnected\\tlocalhost\\thdc\\n" ;; esac\n', { mode: 0o755 });
    expect(await startHarmonyOsEmulator({ ...opts, hdcPort: 12000, logger })).toMatchObject({ address: '127.0.0.1:12000' });
    expect(warnings).toHaveLength(1);
  });

  it('keeps a vsync setting the caller made, and reports an emulator that exits while starting', async () => {
    fake.accept(SERVICE_AGREEMENT);
    fake.write('devices.json', [deviceRecord('Pura 90 HOS7', { instancePath: path.join(tmp, 'deployed', 'Pura 90 HOS7') })]);
    fake.write('start-fails', '');
    const config = staticConfig({ hdcPath: path.join(tmp, 'no-hdc') });
    await expect(
      startHarmonyOsEmulator({ config, emulator, name: 'Pura 90 HOS7', settleMs: 500, home: fake.home, env: { ...fake.env, __GL_SYNC_TO_VBLANK: '1' } }),
    ).rejects.toThrow(/The HarmonyOS emulator exited \(code 1\) while starting "Pura 90 HOS7"\. Tail of .*oniro-app-start\.log:\n.*Unable to start the emulator/s);
    expect(fs.readFileSync(path.join(fake.state, 'vsync'), 'utf8').trim()).toBe('1');
    await expect(startHarmonyOsEmulator({ config, emulator, name: 'Mate', ...run() })).rejects.toThrow(
      'No HarmonyOS emulator device named "Mate". Devices: "Pura 90 HOS7".',
    );
  });

  it('stops a device and waits until it no longer runs', async () => {
    fake.write('devices.json', [deviceRecord('Pura 90 HOS7')]);
    expect(await stopHarmonyOsEmulator({ emulator, name: 'Pura 90 HOS7', ...run() })).toBe(false);
    fake.write('devices.json', [deviceRecord('Pura 90 HOS7', { isRunning: 'true' })]);
    fake.write('devices-after-stop.json', [deviceRecord('Pura 90 HOS7')]);
    expect(await stopHarmonyOsEmulator({ emulator, name: 'Pura 90 HOS7', pollIntervalMs: 50, ...run() })).toBe(true);
    expect(fake.calls().filter((c) => c.startsWith('-stop'))).toEqual(['-stop Pura 90 HOS7']);
    // One that keeps running past the wait is an error.
    fs.rmSync(path.join(fake.state, 'devices-after-stop.json'));
    fake.write('devices.json', [deviceRecord('Pura 90 HOS7', { isRunning: 'true' })]);
    await expect(stopHarmonyOsEmulator({ emulator, name: 'Pura 90 HOS7', waitSeconds: 0, ...run() })).rejects.toThrow(
      '"Pura 90 HOS7" was still running 0s after Emulator -stop.',
    );
  });
});
