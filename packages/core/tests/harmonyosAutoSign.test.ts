import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSON5 from 'json5';
import { harmonyOsAutoSign } from '../src/harmonyos/signing/autoSign.js';
import { SIGNING_ERRORS } from '../src/harmonyos/signing/errors.js';
import type { LocalDevice } from '../src/harmonyos/signing/devices.js';
import type { HarmonyOsSession } from '../src/harmonyos/auth/session.js';
import type { HarmonyOsHttpClient, HttpRequestOptions, HttpResponse } from '../src/harmonyos/http.js';
import { decryptPwd } from '../src/sign/encryptKey.js';
import { staticConfig } from '../src/ports/config.js';

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
}));

// No hdc: the test decides what is attached.
const connected = vi.hoisted(() => ({ devices: [] as LocalDevice[] }));
vi.mock('../src/harmonyos/signing/devices.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  collectLocalDevices: vi.fn(async () => connected.devices),
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
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('has AGC issue a certificate and profile, and writes an encrypted signingConfig', async () => {
    const result = await sign();

    expect(result).toMatchObject({ bundleName: 'com.example.signme', teamId: 'u1', regenerated: true, deviceIds: [UDID] });
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
    await expect(sign()).resolves.toMatchObject({ deviceIds: ['CD'.repeat(32)] });
    expect(agcCalls('/device/add')).toEqual([]);
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
