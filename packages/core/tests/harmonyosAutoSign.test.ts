import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSON5 from 'json5';
import { harmonyOsAutoSign } from '../src/harmonyos/signing/autoSign.js';
import { harmonyOsSignHap } from '../src/harmonyos/signing/signHap.js';
import { defaultSignedHapPath, readHapSigningInfo } from '../src/sign/hapInfo.js';
import { signHapFile } from '../src/harmonyos/signing/keystore.js';
import { makeStoredZip } from './_helpers/storedZip.js';
import { SIGNING_ERRORS } from '../src/harmonyos/signing/errors.js';
import type { LocalDevice } from '../src/harmonyos/signing/devices.js';
import type { HarmonyOsSession } from '../src/harmonyos/auth/session.js';
import type { HarmonyOsHttpClient, HttpRequestOptions, HttpResponse } from '../src/harmonyos/http.js';
import { decryptPwd } from '../src/sign/encryptKey.js';
import { staticConfig } from '../src/ports/config.js';
import { noopLogger } from '../src/ports/logger.js';

// Real hap-sign-tool output (see harmonyosSigning.test.ts): the keystore holds the
// key `debug.cer` certifies, and `other.cer` certifies an unrelated one.
const { FIXTURES, P12_PWD } = vi.hoisted(() => ({
  FIXTURES: `${__dirname}/fixtures/harmonyos`,
  P12_PWD: 'Fixture1234',
}));
const pem = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.cer`), 'utf8');

// hap-sign-tool needs Java and the HarmonyOS SDK; the fixture keystore stands in for its output.
vi.mock('../src/harmonyos/signing/keystore.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateKeystoreAndCsr: vi.fn(async (opts: { p12Path: string; csrPath: string }) => {
    fs.mkdirSync(path.dirname(opts.p12Path), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'debug.p12'), opts.p12Path);
    fs.writeFileSync(opts.csrPath, 'CSR');
    return { keyPwd: P12_PWD, csr: 'CSR' };
  }),
  // Stands in for `hap-sign-tool sign-app`: the output is the input with a marker appended.
  signHapFile: vi.fn(async (opts: { inFile: string; outFile: string }) => {
    fs.writeFileSync(opts.outFile, Buffer.concat([fs.readFileSync(opts.inFile), Buffer.from('SIGNED')]));
  }),
}));

// No hdc: the test decides what is attached.
const connected = vi.hoisted(() => ({ devices: [] as LocalDevice[], skipped: [] as string[] }));
vi.mock('../src/harmonyos/signing/devices.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  collectLocalDevices: vi.fn(async () => ({ devices: connected.devices, skipped: connected.skipped })),
}));

const UDID = 'AB'.repeat(32);
const BASE = 'https://agc.example';

/** A `.p7b` as AGC issues it: DER framing around the plain-text profile JSON. */
function p7b(payload: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x04, 0x01]), Buffer.from(JSON.stringify(payload)), Buffer.from([0x00])]);
}

interface Call {
  method: string;
  path: string;
  opts?: HttpRequestOptions;
}

/** AppGallery Connect in memory, behind the HTTP client interface. */
function fakeAgc() {
  const state = {
    certs: [] as Array<{ id: string; certName: string; certObjectId: string }>,
    devices: [] as Array<{ id: string; udid: string }>,
    profiles: new Map<string, unknown>(),
    objects: new Map<string, Buffer>(),
    /** PEM the next issued profile claims to be for; the issued certificate's by default. */
    profileCertificate: pem('debug'),
    calls: [] as Call[],
  };
  let n = 0;
  const ok = (body: object = {}): HttpResponse => ({ data: JSON.stringify({ ret: { code: 0 }, ...body }), statusCode: 200, statusText: 'OK' });
  const body = (opts?: HttpRequestOptions) => opts?.body as Record<string, any>;

  const respond = (method: string) => async (url: string, opts?: HttpRequestOptions): Promise<HttpResponse> => {
    const { pathname } = new URL(url);
    state.calls.push({ method, path: pathname, opts });
    switch (`${method} ${pathname}`) {
      case 'POST /api/cps/harmony-cert-manage/v1/cert/list':
        return ok({ certList: state.certs });
      case 'POST /api/cps/harmony-cert-manage/v1/cert/add': {
        const id = `cert-${++n}`;
        state.certs.push({ id, certName: body(opts).certName, certObjectId: `obj-${id}` });
        state.objects.set(`obj-${id}`, Buffer.from(pem('debug')));
        return ok();
      }
      case 'DELETE /api/cps/harmony-cert-manage/v1/cert/delete':
        state.certs = state.certs.filter((c) => !body(opts).certIds.includes(c.id));
        return ok();
      case 'GET /api/cps/device-manage/v1/device/list':
        return ok({ list: state.devices, totalCount: state.devices.length });
      case 'POST /api/cps/device-manage/v1/device/add':
        state.devices.push({ id: `device-${++n}`, udid: body(opts).udid });
        return ok();
      case 'POST /api/cps/provision-manage/v1/ide/test/provision/add': {
        const id = `profile-${++n}`;
        const { packageName, deviceList, aclPermissionList } = body(opts);
        state.profiles.set(id, body(opts));
        state.objects.set(
          `obj-${id}`,
          p7b({
            type: 'debug',
            validity: { 'not-before': 1700000000, 'not-after': 4102444800 },
            'bundle-info': { 'bundle-name': packageName, 'developer-id': 'u1', 'development-certificate': state.profileCertificate },
            'debug-info': { 'device-ids': state.devices.filter((d) => deviceList.includes(d.id)).map((d) => d.udid) },
            acls: { 'allowed-acls': aclPermissionList ?? [] },
          }),
        );
        return ok({ id, provisionFileUrl: `obj-${id}` });
      }
      case 'DELETE /api/cps/provision-manage/v1/provision/delete':
        state.profiles.delete(String(opts?.query?.id));
        return ok();
      case 'POST /api/amis/app-manage/v1/objects/url/reapply': {
        const objectId = body(opts).sourceUrls as string;
        const sha256 = crypto.createHash('sha256').update(state.objects.get(objectId)!).digest('hex');
        return ok({ urlsInfo: [{ newUrl: `https://objects.example/${objectId}`, sha256 }] });
      }
      default:
        return { data: '', statusCode: 404, statusText: 'Not Found' };
    }
  };

  const http: HarmonyOsHttpClient = {
    get: respond('GET'),
    post: respond('POST'),
    delete: respond('DELETE'),
    getBinary: async (url) => state.objects.get(path.basename(new URL(url).pathname))!,
  };
  return { http, state };
}

describe('harmonyOsAutoSign', () => {
  let tmp: string;
  let projectDir: string;
  let signingDir: string;
  let agc: ReturnType<typeof fakeAgc>;
  let session: HarmonyOsSession & { resolveAgcAuth: ReturnType<typeof vi.fn> };
  let originalProgramFiles: string | undefined;

  const writeProject = (bundleName: string) => {
    fs.mkdirSync(path.join(projectDir, 'AppScope'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'AppScope', 'app.json5'), JSON.stringify({ app: { bundleName } }));
  };
  const readBuildProfile = () =>
    JSON5.parse(fs.readFileSync(path.join(projectDir, 'build-profile.json5'), 'utf-8')) as {
      app: {
        signingConfigs?: Array<{ name: string; type: string; material: Record<string, string> }>;
        products: Array<Record<string, unknown>>;
      };
    };
  const sign = (overrides: Partial<Parameters<typeof harmonyOsAutoSign>[0]> = {}) =>
    harmonyOsAutoSign({
      config: staticConfig({ harmonyosSdkPath: path.join(tmp, 'sdk'), harmonyosSigningDir: signingDir }),
      session,
      projectDir,
      http: agc.http,
      ...overrides,
    });
  const agcCalls = (suffix: string) => agc.state.calls.filter((c) => c.path.endsWith(suffix));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-autosign-'));
    originalProgramFiles = process.env.ProgramFiles;
    process.env.ProgramFiles = path.join(tmp, 'program-files');
    projectDir = path.join(tmp, 'MyApp');
    signingDir = path.join(tmp, 'signing');
    fs.mkdirSync(path.join(tmp, 'sdk', 'default', 'openharmony'), { recursive: true });

    fs.mkdirSync(path.join(projectDir, 'entry', 'src', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      `// DevEco writes comments\n${JSON.stringify({
        app: { products: [{ name: 'default', runtimeOS: 'HarmonyOS', compileSdkVersion: '6.1.1(24)' }] },
        modules: [{ name: 'entry', srcPath: './entry' }],
      })}`,
    );
    fs.writeFileSync(
      path.join(projectDir, 'entry', 'src', 'main', 'module.json5'),
      JSON.stringify({ module: { requestPermissions: [{ name: 'ohos.permission.READ_CONTACTS' }, { name: 'ohos.permission.INTERNET' }] } }),
    );
    writeProject('com.example.signme');

    connected.devices = [{ serial: 'serial-1', udid: UDID, kind: 'wearable' }];
    connected.skipped = [];
    agc = fakeAgc();
    session = {
      resolveAgcAuth: vi.fn(async ({ teamId }: { teamId?: string } = {}) => ({
        uid: 'u1',
        teamId: teamId ?? 'u1',
        accessToken: 'at',
        baseUrl: BASE,
      })),
    } as unknown as typeof session;
  });

  afterEach(() => {
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = originalProgramFiles;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('has AGC issue a certificate and profile, and writes an encrypted signingConfig', async () => {
    const result = await sign();

    expect(result).toMatchObject({ bundleName: 'com.example.signme', teamId: 'u1', regenerated: true, deviceIds: [UDID] });
    // What `sign --harmonyos` prints: "debug, valid until ...".
    expect(result).toMatchObject({ profileType: 'debug', notAfter: new Date(4102444800 * 1000) });
    for (const file of Object.values(result.paths)) {
      expect(path.dirname(file)).toBe(signingDir);
      expect(fs.existsSync(file)).toBe(true);
    }

    // The connected device was registered, with its kind.
    expect(agcCalls('/device/add').map((c) => c.opts?.body)).toEqual([
      { deviceName: expect.stringMatching(/^oniro_app_device_[0-9a-f]{8}$/), udid: UDID, deviceType: '2' },
    ]);
    // Every call carries the account's credentials.
    for (const call of agc.state.calls) expect(call.opts?.headers).toEqual({ uid: 'u1', teamId: 'u1', oauth2Token: 'at' });

    expect(agcCalls('/cert/add').map((c) => c.opts?.body)).toEqual([{ csr: 'CSR', certName: 'oniro_debug_u1.cer', certType: '1' }]);
    expect(agcCalls('/provision/add').map((c) => c.opts?.body)).toEqual([
      {
        provisionName: expect.stringMatching(/^oniro_[0-9a-f]{12}$/),
        packageName: 'com.example.signme',
        certList: [agc.state.certs[0]!.id],
        deviceList: [agc.state.devices[0]!.id],
        // Only the ACL-gated permission; INTERNET needs no profile entry.
        aclPermissionList: ['ohos.permission.READ_CONTACTS'],
      },
    ]);
    // The profile record is deleted once downloaded, so it spends none of the team's quota.
    expect(agc.state.profiles.size).toBe(0);

    const { app } = readBuildProfile();
    expect(app.products).toEqual([
      { name: 'default', runtimeOS: 'HarmonyOS', compileSdkVersion: '6.1.1(24)', signingConfig: 'default' },
    ]);
    expect(app.signingConfigs).toEqual([
      {
        name: 'default',
        type: 'HarmonyOS',
        material: {
          certpath: result.paths.cerPath,
          keyAlias: 'debugKey',
          keyPassword: expect.any(String),
          profile: result.paths.profilePath,
          signAlg: 'SHA256withECDSA',
          storeFile: result.paths.p12Path,
          storePassword: expect.any(String),
        },
      },
    ]);
    // hvigor decrypts the password with the material next to the keystore.
    const material = path.join(signingDir, 'material');
    expect(decryptPwd(app.signingConfigs![0]!.material.storePassword!, material)).toBe(P12_PWD);
    expect(decryptPwd(app.signingConfigs![0]!.material.keyPassword!, material)).toBe(P12_PWD);
  });

  it('reuses still-valid material without calling AGC', async () => {
    await sign();
    const callsAfterFirst = agc.state.calls.length;
    const material = fs.readdirSync(path.join(signingDir, 'material'), { recursive: true });

    const result = await sign();

    expect(result).toMatchObject({ regenerated: false, deviceIds: [UDID] });
    expect(agc.state.calls).toHaveLength(callsAfterFirst);
    // The shared password material is kept, so other projects' configs still decrypt.
    expect(fs.readdirSync(path.join(signingDir, 'material'), { recursive: true })).toEqual(material);
  });

  it('regenerates when forced, or when the project changes under the material', async () => {
    await sign();
    await expect(sign({ force: true })).resolves.toMatchObject({ regenerated: true });
    writeProject('com.example.renamed');
    await expect(sign()).resolves.toMatchObject({ regenerated: true, bundleName: 'com.example.renamed' });
    expect(agcCalls('/cert/add')).toHaveLength(3);
    // One certificate at a time: each run replaced its predecessor.
    expect(agc.state.certs).toHaveLength(1);
  });

  it("replaces only its own certificate, never DevEco Studio's", async () => {
    agc.state.certs.push(
      { id: 'studio', certName: 'auto_debug_u1.cer', certObjectId: 'x' },
      { id: 'stale', certName: 'oniro_debug_u1.cer', certObjectId: 'y' },
    );
    await sign();
    expect(agcCalls('/cert/delete').map((c) => c.opts?.body)).toEqual([{ certIds: ['stale'] }]);
    expect(agc.state.certs.map((c) => c.certName)).toEqual(['auto_debug_u1.cer', 'oniro_debug_u1.cer']);
  });

  it('signs under the requested team, and a product that overrides the bundle name', async () => {
    const profile = readBuildProfile();
    profile.app.products.push({ name: 'phone', bundleName: 'com.example.phone', runtimeOS: 'HarmonyOS' });
    fs.writeFileSync(path.join(projectDir, 'build-profile.json5'), JSON.stringify(profile));

    const result = await sign({ productName: 'phone', teamId: 'team.9' });

    expect(session.resolveAgcAuth).toHaveBeenCalledWith({ teamId: 'team.9' });
    expect(result).toMatchObject({ bundleName: 'com.example.phone', teamId: 'team.9' });
    expect(agcCalls('/cert/add')[0]!.opts?.body).toMatchObject({ certName: 'oniro_debug_team9.cer' });
    expect(path.basename(result.paths.p12Path)).toMatch(/^phone_MyApp_/);
    const { app } = readBuildProfile();
    expect(app.signingConfigs!.map((c) => c.name)).toEqual(['phone']);
    expect(app.products.map((p) => p.signingConfig)).toEqual([undefined, 'phone']);
  });

  it('with no device attached, names the devices already registered to the team', async () => {
    connected.devices = [];
    agc.state.devices.push({ id: 'registered', udid: 'CD'.repeat(32) });
    const warn = vi.fn();
    await expect(sign({ logger: { ...noopLogger, warn } })).resolves.toMatchObject({ deviceIds: ['CD'.repeat(32)] });
    expect(agcCalls('/device/add')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[harmonyos] No device is connected; the profile will name the 1 device(s) already registered to this team.',
    );
  });

  it('with only an unusable device attached, does not claim that none is connected', async () => {
    connected.devices = [];
    connected.skipped = ['GS6CTU300263'];
    agc.state.devices.push({ id: 'registered', udid: 'CD'.repeat(32) });
    const warn = vi.fn();
    await expect(sign({ logger: { ...noopLogger, warn } })).resolves.toMatchObject({ deviceIds: ['CD'.repeat(32)] });
    expect(warn.mock.calls).toEqual([
      ['[harmonyos] No connected device could be registered; the profile will name the 1 device(s) already registered to this team.'],
    ]);
  });

  it('keeps the existing material when there is no device to issue a profile for', async () => {
    const { paths } = await sign();
    connected.devices = [];
    agc.state.devices = [];
    await expect(sign({ force: true })).rejects.toThrow(SIGNING_ERRORS.DEVICE_NONE);
    for (const file of Object.values(paths)) expect(fs.existsSync(file)).toBe(true);
    expect(agcCalls('/cert/delete')).toEqual([]);
  });

  it('refuses a bad bundle name before contacting anyone', async () => {
    writeProject('bad');
    await expect(sign()).rejects.toThrow(SIGNING_ERRORS.BUNDLE_NAME_INVALID);
    expect(session.resolveAgcAuth).not.toHaveBeenCalled();
    expect(agc.state.calls).toEqual([]);
  });

  it('names a product the project does not declare, or a profile it cannot read', async () => {
    await expect(sign({ productName: 'absent' })).rejects.toThrow(/declares no product named 'absent'/);
    fs.rmSync(path.join(projectDir, 'build-profile.json5'));
    await expect(sign()).rejects.toThrow(/Could not read .*build-profile\.json5/);
  });

  it('still signs when AGC will not delete the downloaded profile record', async () => {
    const remove = agc.http.delete;
    agc.http.delete = async (url, opts) =>
      url.endsWith('/provision/delete') ? { data: '', statusCode: 500, statusText: '' } : remove(url, opts);
    await expect(sign()).resolves.toMatchObject({ regenerated: true });
    expect(readBuildProfile().app.signingConfigs).toHaveLength(1);
  });

  it('fails without a HarmonyOS SDK before contacting anyone', async () => {
    fs.rmSync(path.join(tmp, 'sdk'), { recursive: true });
    await expect(sign({ config: staticConfig({ harmonyosSdkPath: path.join(tmp, 'sdk'), cmdToolsPath: tmp }) })).rejects.toThrow(
      /No HarmonyOS SDK found/,
    );
    expect(session.resolveAgcAuth).not.toHaveBeenCalled();
  });

  it('discards a profile issued for another certificate, and writes no config', async () => {
    agc.state.profileCertificate = pem('other');
    await expect(sign()).rejects.toThrow(SIGNING_ERRORS.CERT_PROFILE_MISMATCH);
    expect(fs.readdirSync(signingDir).some((f) => f.endsWith('.p7b'))).toBe(false);
    expect(readBuildProfile().app.signingConfigs).toBeUndefined();
    // The AGC record is cleaned up either way.
    expect(agc.state.profiles.size).toBe(0);
  });
});

describe('harmonyOsSignHap', () => {
  let tmp: string;
  let signingDir: string;
  let hapPath: string;
  let agc: ReturnType<typeof fakeAgc>;
  let session: HarmonyOsSession & { resolveAgcAuth: ReturnType<typeof vi.fn> };
  let originalProgramFiles: string | undefined;

  const writeHap = (file: string, moduleJson: object | string | null, extra: Array<{ name: string; data: Buffer }> = []) => {
    const entries = [...extra];
    if (moduleJson !== null) {
      entries.push({ name: 'module.json', data: Buffer.from(typeof moduleJson === 'string' ? moduleJson : JSON.stringify(moduleJson)) });
    }
    fs.writeFileSync(file, makeStoredZip(entries));
  };
  const moduleJson = (bundleName: string, permissions: string[] = []) => ({
    app: { bundleName },
    module: { name: 'entry', requestPermissions: permissions.map((name) => ({ name })) },
  });
  const signHap = (overrides: Partial<Parameters<typeof harmonyOsSignHap>[0]> = {}) =>
    harmonyOsSignHap({
      config: staticConfig({ harmonyosSdkPath: path.join(tmp, 'sdk'), harmonyosSigningDir: signingDir }),
      session,
      hapPath,
      http: agc.http,
      ...overrides,
    });
  const agcCalls = (suffix: string) => agc.state.calls.filter((c) => c.path.endsWith(suffix));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-signhap-'));
    originalProgramFiles = process.env.ProgramFiles;
    process.env.ProgramFiles = path.join(tmp, 'program-files');
    signingDir = path.join(tmp, 'signing');
    fs.mkdirSync(path.join(tmp, 'sdk', 'default', 'openharmony'), { recursive: true });
    hapPath = path.join(tmp, 'entry-default-unsigned.hap');
    writeHap(hapPath, moduleJson('com.example.prebuilt', ['ohos.permission.READ_CONTACTS', 'ohos.permission.INTERNET']));

    vi.mocked(signHapFile).mockClear();
    connected.devices = [{ serial: 'serial-1', udid: UDID, kind: 'phone' }];
    connected.skipped = [];
    agc = fakeAgc();
    session = {
      resolveAgcAuth: vi.fn(async ({ teamId }: { teamId?: string } = {}) => ({
        uid: 'u1',
        teamId: teamId ?? 'u1',
        accessToken: 'at',
        baseUrl: BASE,
      })),
    } as unknown as typeof session;
  });

  afterEach(() => {
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = originalProgramFiles;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("issues material for the HAP's own bundle and ACL permissions, and signs a copy next to it", async () => {
    const result = await signHap();

    const outPath = path.join(tmp, 'entry-default-signed.hap');
    expect(result).toMatchObject({ bundleName: 'com.example.prebuilt', teamId: 'u1', regenerated: true, deviceIds: [UDID], outPath });
    expect(result).toMatchObject({ profileType: 'debug', notAfter: new Date(4102444800 * 1000) });
    expect(agcCalls('/provision/add').map((c) => c.opts?.body)).toEqual([
      expect.objectContaining({ packageName: 'com.example.prebuilt', aclPermissionList: ['ohos.permission.READ_CONTACTS'] }),
    ]);
    expect(agc.state.profiles.size).toBe(0);
    for (const file of Object.values(result.paths)) expect(path.dirname(file)).toBe(signingDir);
    expect(path.basename(result.paths.p12Path)).toMatch(/^hap_com\.example\.prebuilt_/);

    expect(vi.mocked(signHapFile).mock.calls).toEqual([
      [
        expect.objectContaining({
          inFile: hapPath,
          outFile: expect.stringContaining(path.join(tmp, '.entry-default-signed.hap.')),
          cerPath: result.paths.cerPath,
          profilePath: result.paths.profilePath,
          p12Path: result.paths.p12Path,
          keyPwd: P12_PWD,
        }),
      ],
    ]);
    expect(fs.readFileSync(outPath).subarray(-6).toString()).toBe('SIGNED');
    // The input is left alone, and no temporary file survives.
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.hap')).sort()).toEqual(['entry-default-signed.hap', 'entry-default-unsigned.hap']);
    expect(fs.readdirSync(tmp).some((f) => f.endsWith('.tmp'))).toBe(false);
    // The keystore password is stored encrypted, so the next run can reuse the material.
    const pwdFile = result.paths.p12Path.replace(/\.p12$/, '.pwd');
    expect(decryptPwd(fs.readFileSync(pwdFile, 'utf8'), path.join(signingDir, 'material'))).toBe(P12_PWD);
  });

  it('reuses still-valid material, and regenerates when forced or when the password is gone', async () => {
    const { paths } = await signHap();
    const callsAfterFirst = agc.state.calls.length;

    await expect(signHap({ outPath: path.join(tmp, 'again.hap') })).resolves.toMatchObject({ regenerated: false });
    expect(agc.state.calls).toHaveLength(callsAfterFirst);
    expect(vi.mocked(signHapFile).mock.calls[1]![0]).toMatchObject({ keyPwd: P12_PWD });

    await expect(signHap({ force: true })).resolves.toMatchObject({ regenerated: true });
    fs.rmSync(paths.p12Path.replace(/\.p12$/, '.pwd'));
    await expect(signHap()).resolves.toMatchObject({ regenerated: true });
    expect(agcCalls('/cert/add')).toHaveLength(3);
  });

  it('regenerates when the HAP requests an ACL permission the profile lacks', async () => {
    await signHap();
    writeHap(hapPath, moduleJson('com.example.prebuilt', ['ohos.permission.READ_CONTACTS', 'ohos.permission.READ_AUDIO']));
    await expect(signHap()).resolves.toMatchObject({ regenerated: true });
    expect(agcCalls('/provision/add').at(-1)!.opts?.body).toMatchObject({
      aclPermissionList: ['ohos.permission.READ_AUDIO', 'ohos.permission.READ_CONTACTS'],
    });
  });

  it('creates the output directory', async () => {
    const outPath = path.join(tmp, 'out', 'nested', 'app.hap');
    await expect(signHap({ outPath })).resolves.toMatchObject({ outPath });
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('re-signs a HAP in place when the output is the input', async () => {
    const before = fs.readFileSync(hapPath);
    await expect(signHap({ outPath: hapPath })).resolves.toMatchObject({ outPath: hapPath });
    expect(fs.readFileSync(hapPath)).toEqual(Buffer.concat([before, Buffer.from('SIGNED')]));
  });

  it('leaves no output behind when hap-sign-tool fails', async () => {
    vi.mocked(signHapFile).mockImplementationOnce(async (opts) => {
      fs.writeFileSync(opts.outFile, 'partial');
      throw new Error('hap-sign-tool failed to sign');
    });
    await expect(signHap()).rejects.toThrow(/failed to sign/);
    expect(fs.readdirSync(tmp).filter((f) => f.includes('signed'))).toEqual(['entry-default-unsigned.hap']);
  });

  it('refuses a HAP it cannot sign before contacting anyone', async () => {
    writeHap(hapPath, moduleJson('bad'));
    await expect(signHap()).rejects.toThrow(SIGNING_ERRORS.BUNDLE_NAME_INVALID);
    writeHap(hapPath, { ...moduleJson('com.example.prebuilt'), app: { bundleName: 'com.example.prebuilt', compileSdkType: 'OpenHarmony' } });
    await expect(signHap()).rejects.toThrow(/built for OpenHarmony.*without --harmonyos/);
    writeHap(hapPath, null, [{ name: 'config.json', data: Buffer.from('{}') }]);
    await expect(signHap()).rejects.toThrow(/FA-model HAP/);
    fs.writeFileSync(hapPath, 'not a zip');
    await expect(signHap()).rejects.toThrow(/Could not read .* as a HAP/);
    await expect(signHap({ hapPath: path.join(tmp, 'absent.hap') })).rejects.toThrow(/does not exist/);
    expect(session.resolveAgcAuth).not.toHaveBeenCalled();
    expect(agc.state.calls).toEqual([]);
  });
});

describe('readHapSigningInfo', () => {
  it("reads the bundle name and requested permissions from a HAP's module.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hapinfo-'));
    try {
      const hap = path.join(dir, 'a.hap');
      const json = { app: { bundleName: 'com.example.a' }, module: { requestPermissions: [{ name: 'p.one' }, {}, { name: 'p.two' }] } };
      fs.writeFileSync(hap, makeStoredZip([{ name: 'module.json', data: Buffer.from(`\uFEFF${JSON.stringify(json)}`) }]));
      await expect(readHapSigningInfo(hap)).resolves.toEqual({ bundleName: 'com.example.a', requestedPermissions: ['p.one', 'p.two'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultSignedHapPath', () => {
  it('names the signed copy as hvigor does', () => {
    expect(defaultSignedHapPath('/x/entry-default-unsigned.hap')).toBe(path.join('/x', 'entry-default-signed.hap'));
    // Never the input itself.
    expect(defaultSignedHapPath('/x/entry-default-signed.hap')).toBe(path.join('/x', 'entry-default-resigned.hap'));
    expect(defaultSignedHapPath('/x/App.HAP')).toBe(path.join('/x', 'App-signed.hap'));
  });
});
