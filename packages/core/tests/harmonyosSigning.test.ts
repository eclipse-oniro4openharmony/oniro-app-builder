import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { SIGNING_ERRORS, mapAgcError } from '../src/harmonyos/signing/errors.js';
import { createAgcClient } from '../src/harmonyos/signing/agc.js';
import { resolveSigningMaterialPaths, sanitizeNamePart } from '../src/harmonyos/signing/paths.js';
import { generateKeystoreAndCsr, redactArgs } from '../src/harmonyos/signing/keystore.js';
import {
  extractProfileJson,
  keystoreHoldsKey,
  readProvisionProfile,
  verifySigningMaterial,
} from '../src/harmonyos/signing/profile.js';
import { shouldRegenerate, writeSigningConfig } from '../src/harmonyos/signing/autoSign.js';
import { collectAclPermissions } from '../src/harmonyos/signing/project.js';
import type { HarmonyOsHttpClient, HttpResponse } from '../src/harmonyos/http.js';
import { staticConfig } from '../src/ports/config.js';
import { ChecksumMismatchError } from '../src/ports/errors.js';
import type { Logger } from '../src/ports/logger.js';

describe('mapAgcError', () => {
  it('maps a proxy-blocked 403 to a network error, any other 403 to permissions', () => {
    expect(mapAgcError('cert', 403, 'Openproxy_Blocked_URL_list', '').message).toBe(SIGNING_ERRORS.NETWORK);
    expect(mapAgcError('cert', 403, 'Forbidden', '').message).toBe(SIGNING_ERRORS.FORBIDDEN);
  });

  it('maps 401 to a re-login hint', () => {
    expect(mapAgcError('profile', 401, 'Unauthorized', '').message).toBe(SIGNING_ERRORS.UNAUTHORIZED);
  });

  it('maps known ret codes under HTTP 200', () => {
    const of = (code: number) => mapAgcError('device', 200, 'OK', JSON.stringify({ ret: { code } }));
    expect(of(205389872).message).toBe(SIGNING_ERRORS.CERT_LIMIT);
    expect(of(205389872).retCode).toBe('205389872');
    expect(of(205389904).message).toBe(SIGNING_ERRORS.USER_NOT_HARMONY);
    expect(of(205389859).message).toBe(SIGNING_ERRORS.DEVICE_LIMIT);
    expect(of(205389857).message).toBe(SIGNING_ERRORS.DEVICE_NAME_REPEAT);
    expect(of(205389938).message).toBe(SIGNING_ERRORS.PROVISION_LIMIT);
    expect(of(205389830).message).toBe(SIGNING_ERRORS.PROFILE_NAME_REPEAT);
  });

  it("surfaces AGC's own ret.msg, even from a ret that is a JSON string", () => {
    expect(mapAgcError('cert', 200, 'OK', JSON.stringify({ ret: { code: 1, msg: 'specific' } })).message).toBe(
      'specific',
    );
    expect(mapAgcError('cert', 200, 'OK', JSON.stringify({ ret: JSON.stringify({ msg: 'nested' }) })).message).toBe(
      'nested',
    );
  });

  it('falls back to a per-operation message', () => {
    expect(mapAgcError('cert', 500, '', 'garbage').message).toBe(SIGNING_ERRORS.CERT_REQUEST);
    expect(mapAgcError('device', 500, '', 'garbage').message).toBe(SIGNING_ERRORS.DEVICE_ADD);
    expect(mapAgcError('profile', 500, '', 'garbage').message).toBe(SIGNING_ERRORS.PROFILE_ADD);
  });
});

describe('AGC client', () => {
  const auth = { uid: 'u', teamId: 't', accessToken: 'at', baseUrl: 'https://agc.example' };
  const client = (response: Partial<HttpResponse>, binary = Buffer.from('')) => {
    const respond = async (): Promise<HttpResponse> => ({ data: '', statusCode: 200, statusText: '', ...response });
    const http: HarmonyOsHttpClient = { get: respond, post: respond, delete: respond, getBinary: async () => binary };
    return createAgcClient(http, auth);
  };

  it('returns the body when ret.code is 0', async () => {
    const certList = [{ id: '1', certName: 'c', certObjectId: 'o' }];
    await expect(client({ data: JSON.stringify({ ret: { code: 0 }, certList }) }).listCertificates()).resolves.toEqual(
      certList,
    );
  });

  it('treats a non-zero ret.code under HTTP 200 as a failure', async () => {
    const agc = client({ data: JSON.stringify({ ret: { code: 205389872 } }) });
    await expect(agc.addCertificate('c', 'csr')).rejects.toThrow(SIGNING_ERRORS.CERT_LIMIT);
  });

  it('pages through every registered device', async () => {
    const all = Array.from({ length: 150 }, (_, i) => ({ id: `d${i}`, udid: `u${i}` }));
    const pages: unknown[] = [];
    const http: HarmonyOsHttpClient = {
      get: async (_url, opts) => {
        pages.push(opts?.query);
        const { start, pageSize } = opts!.query as { start: number; pageSize: number };
        const list = all.slice((start - 1) * pageSize, start * pageSize);
        return { data: JSON.stringify({ ret: { code: 0 }, list, totalCount: all.length }), statusCode: 200, statusText: 'OK' };
      },
      post: async () => ({ data: '', statusCode: 500, statusText: '' }),
      delete: async () => ({ data: '', statusCode: 500, statusText: '' }),
      getBinary: async () => Buffer.from(''),
    };
    await expect(createAgcClient(http, auth).listDevices()).resolves.toEqual(all);
    expect(pages).toEqual([
      { encodeFlag: 0, start: 1, pageSize: 100 },
      { encodeFlag: 0, start: 2, pageSize: 100 },
    ]);
  });

  it('maps an HTTP failure to its remedy', async () => {
    await expect(client({ statusCode: 401, data: '' }).listDevices()).rejects.toThrow(SIGNING_ERRORS.UNAUTHORIZED);
    await expect(client({ statusCode: 500, data: 'oops' }).deleteProfile('p')).rejects.toThrow(SIGNING_ERRORS.PROFILE_ADD);
  });

  it('fails a download AGC offers no URL for', async () => {
    await expect(client({ data: JSON.stringify({ ret: { code: 0 }, urlsInfo: [] }) }).download('profile', 'o', '/unused')).rejects.toThrow(
      SIGNING_ERRORS.PROFILE_ADD,
    );
  });

  it('writes a download only when its digest matches', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-agc-'));
    try {
      const payload = Buffer.from('certificate bytes');
      const urls = (sha256: string) => ({
        data: JSON.stringify({ ret: { code: 0 }, urlsInfo: [{ newUrl: 'https://obj.example/x', sha256 }] }),
      });
      const good = crypto.createHash('sha256').update(payload).digest('hex');

      await expect(client(urls('00'.repeat(32)), payload).download('cert', 'o', path.join(tmp, 'bad.cer'))).rejects.toThrow(
        ChecksumMismatchError,
      );
      expect(fs.existsSync(path.join(tmp, 'bad.cer'))).toBe(false);

      await client(urls(good.toUpperCase()), payload).download('cert', 'o', path.join(tmp, 'good.cer'));
      expect(fs.readFileSync(path.join(tmp, 'good.cer'))).toEqual(payload);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('signing material paths', () => {
  const config = staticConfig({ harmonyosSigningDir: '/material' });

  it('gives the four files one base name, keyed by product and project path', () => {
    const paths = resolveSigningMaterialPaths(config, 'default', '/projects/MyApp');
    const bases = Object.values(paths).map((p) => p.replace(/\.[^.]+$/, ''));
    expect(new Set(bases).size).toBe(1);
    expect(path.basename(paths.p12Path)).toMatch(/^default_MyApp_[A-Za-z0-9]+=\.p12$/);
    expect(resolveSigningMaterialPaths(config, 'default', '/projects/other/MyApp').p12Path).not.toBe(paths.p12Path);
  });

  it('sanitises product names for use in filenames', () => {
    expect(sanitizeNamePart('my/product:name')).toBe('my_product_name');
    expect(sanitizeNamePart('')).toBe('default');
    expect(sanitizeNamePart(undefined)).toBe('default');
    expect(sanitizeNamePart('a'.repeat(200))).toHaveLength(64);
  });

  it('redacts passwords from hap-sign-tool argv', () => {
    const redacted = redactArgs(['generate-keypair', '-keyAlias', 'debugKey', '-keyPwd', 'hunter2', '-keystorePwd', 'hunter2']);
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('debugKey');
  });
});

describe.skipIf(process.platform === 'win32')('generateKeystoreAndCsr', () => {
  let tmp: string;
  let sdk: { sdkPath: string; installRoot: string };
  const debug: string[] = [];
  const logger: Logger = { debug: (m) => debug.push(m), info() {}, warn() {}, error() {} };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-keystore-'));
    sdk = { sdkPath: path.join(tmp, 'sdk'), installRoot: tmp };
    const lib = path.join(sdk.sdkPath, 'default', 'openharmony', 'toolchains', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'hap-sign-tool.jar'), '');
    // A `java` that logs its argv, writes any -outFile, and fails when asked to.
    const bin = path.join(tmp, 'jdk', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'java'),
      [
        '#!/bin/sh',
        `echo "$*" >> "${tmp}/argv.log"`,
        '[ -n "$FAKE_JAVA_FAIL" ] && { echo "keytool error: boom" >&2; exit 3; }',
        'prev=""; for a in "$@"; do [ "$prev" = "-outFile" ] && printf "CSR-CONTENT" > "$a"; prev="$a"; done',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
    vi.stubEnv('JAVA_HOME', path.join(tmp, 'jdk'));
    debug.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const generate = () =>
    generateKeystoreAndCsr({
      sdk,
      p12Path: path.join(tmp, 'material', 'app.p12'),
      csrPath: path.join(tmp, 'material', 'app.csr'),
      logger,
    });

  it("generates an ECC key pair and a CSR with the SDK's hap-sign-tool, under a random password", async () => {
    const { keyPwd, csr } = await generate();
    expect(csr).toBe('CSR-CONTENT');
    expect(keyPwd).toMatch(/^[A-Za-z0-9]{12,}$/);
    await expect(generate()).resolves.not.toMatchObject({ keyPwd });

    const jar = path.join(sdk.sdkPath, 'default', 'openharmony', 'toolchains', 'lib', 'hap-sign-tool.jar');
    const store = `-keyAlias debugKey -keystoreFile ${path.join(tmp, 'material', 'app.p12')} -keystorePwd ${keyPwd} -keyPwd ${keyPwd}`;
    expect(fs.readFileSync(path.join(tmp, 'argv.log'), 'utf8').split('\n').slice(0, 2)).toEqual([
      `-jar ${jar} generate-keypair -keyAlg ECC -keySize NIST-P-256 ${store}`,
      `-jar ${jar} generate-csr -subject CN=DebugKey -signAlg SHA256withECDSA -outFile ${path.join(tmp, 'material', 'app.csr')} ${store}`,
    ]);
    // The password is never logged.
    expect(debug.length).toBeGreaterThan(0);
    expect(debug.join('\n')).not.toContain(keyPwd);
  });

  it("reports hap-sign-tool's own error", async () => {
    vi.stubEnv('FAKE_JAVA_FAIL', '1');
    await expect(generate()).rejects.toThrow(/hap-sign-tool failed to generate the key pair \(exit 3\)\.\nkeytool error: boom/);
  });

  it('names an SDK without hap-sign-tool as incomplete', async () => {
    fs.rmSync(sdk.sdkPath, { recursive: true });
    await expect(generate()).rejects.toThrow(/hap-sign-tool\.jar not found .* looks incomplete/);
  });
});

// Real hap-sign-tool keystores (ECC P-256, Java 21 PKCS#12 with PBES2/AES-256), each
// with its self-signed certificate — the same public key AGC certifies from the CSR.
// `other` is an unrelated key pair.
const FIXTURES = path.join(__dirname, 'fixtures', 'harmonyos');
const P12 = path.join(FIXTURES, 'debug.p12');
const P12_PWD = 'Fixture1234';
const pem = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.cer`), 'utf8');

/** A fake `.p7b`: DER-ish noise around the plain-text profile JSON. */
function fakeProfile(payload: Record<string, unknown>): Buffer {
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x04, 0x01, 0x06, 0x09]),
    Buffer.from(JSON.stringify(payload), 'utf8'),
    Buffer.from([0x00, 0x01, 0x02]),
  ]);
}

const PROFILE_PAYLOAD = {
  type: 'debug',
  validity: { 'not-before': 1700000000, 'not-after': 4102444800 },
  'bundle-info': { 'bundle-name': 'com.example.app', 'developer-id': 'team-1', 'development-certificate': 'PEM' },
  'debug-info': { 'device-id-type': 'udid', 'device-ids': ['aa'.repeat(32)] },
  acls: { 'allowed-acls': ['ohos.permission.READ_CONTACTS'] },
};

describe('provisioning profile', () => {
  it('recovers the JSON payload from binary framing, skipping other brace pairs', () => {
    const buffer = Buffer.concat([Buffer.from('{"unrelated":1}'), fakeProfile({ ...PROFILE_PAYLOAD, note: 'a } {' })]);
    const json = JSON.parse(extractProfileJson(buffer)!);
    expect(json['bundle-info']['bundle-name']).toBe('com.example.app');
    expect(json.note).toBe('a } {');
    expect(extractProfileJson(Buffer.from([0x30, 0x82, 0x00]))).toBeNull();
  });

  it('reads the fields reuse and verification depend on', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-p7b-'));
    try {
      const file = path.join(tmp, 'profile.p7b');
      fs.writeFileSync(file, fakeProfile(PROFILE_PAYLOAD));
      expect(readProvisionProfile(file)).toEqual({
        bundleName: 'com.example.app',
        developerId: 'team-1',
        notAfter: new Date(4102444800 * 1000),
        deviceIds: ['AA'.repeat(32)],
        aclPermissions: ['ohos.permission.READ_CONTACTS'],
        developmentCertificate: 'PEM',
      });
      expect(readProvisionProfile(path.join(tmp, 'absent.p7b'))).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('keystore and certificate agreement', () => {
  it('matches an ECC keystore to a certificate for its key', () => {
    // node-forge parses only RSA certificates, so this failed for every
    // hap-sign-tool keystore until the certificate went to Node's parser instead.
    expect(keystoreHoldsKey(P12, 'debugKey', P12_PWD, new X509Certificate(pem('debug')))).toBe(true);
  });

  it('rejects a certificate for another key, and a wrong password', () => {
    expect(keystoreHoldsKey(P12, 'debugKey', P12_PWD, new X509Certificate(pem('other')))).toBe(false);
    expect(keystoreHoldsKey(P12, 'debugKey', 'wrong', new X509Certificate(pem('debug')))).toBe(false);
  });

  describe('verifySigningMaterial', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-verify-'));
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const verify = (cer: string, issuedFor: string, now?: Date, cerContent = pem(cer)) => {
      const cerPath = path.join(tmp, 'x.cer');
      const profilePath = path.join(tmp, 'x.p7b');
      fs.writeFileSync(cerPath, cerContent);
      fs.writeFileSync(profilePath, fakeProfile({ 'bundle-info': { 'development-certificate': pem(issuedFor) } }));
      verifySigningMaterial({ profilePath, cerPath, p12Path: P12, keyAlias: 'debugKey', keyPwd: P12_PWD, now });
    };

    it('names a certificate outside its validity window', () => {
      const { validFrom, validTo } = new X509Certificate(pem('debug'));
      expect(() => verify('debug', 'debug', new Date(Date.parse(validFrom) - 1000))).toThrow(SIGNING_ERRORS.CERT_EXPIRED);
      expect(() => verify('debug', 'debug', new Date(Date.parse(validTo) + 1000))).toThrow(SIGNING_ERRORS.CERT_EXPIRED);
    });

    it('names a certificate file that holds no usable certificate', () => {
      expect(() => verify('debug', 'debug', undefined, 'not a certificate')).toThrow(SIGNING_ERRORS.CERT_INVALID);
      const garbled = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
      expect(() => verify('debug', 'debug', undefined, garbled)).toThrow(SIGNING_ERRORS.CERT_INVALID);
    });

    it('accepts agreeing material', () => {
      expect(() => verify('debug', 'debug')).not.toThrow();
    });

    it('names a profile issued for another certificate', () => {
      expect(() => verify('debug', 'other')).toThrow(SIGNING_ERRORS.CERT_PROFILE_MISMATCH);
    });

    it('names a keystore that does not hold the certified key', () => {
      expect(() => verify('other', 'other')).toThrow(SIGNING_ERRORS.KEYSTORE_CERT_MISMATCH);
    });
  });
});

describe('shouldRegenerate', () => {
  let tmp: string;
  let paths: ReturnType<typeof resolveSigningMaterialPaths>;

  const input = (overrides: Record<string, unknown> = {}) => ({
    paths,
    buildProfile: {
      app: { signingConfigs: [{ name: 'default', type: 'HarmonyOS', material: { profile: paths.profilePath } }] },
    },
    productName: 'default',
    bundleName: 'com.example.app',
    teamId: 'team-1',
    connectedUdids: ['aa'.repeat(32)],
    aclPermissions: ['ohos.permission.READ_CONTACTS'],
    ...overrides,
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-regen-'));
    paths = resolveSigningMaterialPaths(staticConfig({ harmonyosSigningDir: tmp }), 'default', '/projects/MyApp');
    for (const file of Object.values(paths)) fs.writeFileSync(file, 'x');
    fs.writeFileSync(paths.profilePath, fakeProfile(PROFILE_PAYLOAD));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reuses valid material', () => {
    expect(shouldRegenerate(input())).toBeNull();
  });

  it('says why it cannot reuse', () => {
    expect(shouldRegenerate(input({ force: true }))).toMatch(/force/);
    expect(shouldRegenerate(input({ bundleName: 'com.example.other' }))).toMatch(/com\.example\.app/);
    expect(shouldRegenerate(input({ teamId: 'team-2' }))).toMatch(/team-1/);
    expect(shouldRegenerate(input({ connectedUdids: ['BB'.repeat(32)] }))).toMatch(/not named in the profile/);
    expect(shouldRegenerate(input({ aclPermissions: ['ohos.permission.CAPTURE_SCREEN'] }))).toMatch(/CAPTURE_SCREEN/);
    expect(shouldRegenerate(input({ now: new Date(4102444800 * 1000) }))).toMatch(/expired/);
  });

  it('regenerates when the project has no signingConfig for the material', () => {
    // A fresh checkout: the keystore password lives only in the project's config.
    expect(shouldRegenerate(input({ buildProfile: {} }))).toMatch(/no signingConfig/);
  });

  it('regenerates when a file is missing or the profile is unreadable', () => {
    fs.writeFileSync(paths.profilePath, 'not a profile');
    expect(shouldRegenerate(input())).toMatch(/could not be read/);
    fs.rmSync(paths.cerPath);
    expect(shouldRegenerate(input())).toMatch(/missing/);
  });
});

describe('writeSigningConfig', () => {
  let projectDir: string;
  const paths = { p12Path: '/m/app.p12', csrPath: '/m/app.csr', cerPath: '/m/app.cer', profilePath: '/m/app.p7b' };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-profile-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const write = (buildProfile: Record<string, unknown>) => {
    const buildProfilePath = path.join(projectDir, 'build-profile.json5');
    writeSigningConfig({ buildProfilePath, buildProfile, productName: 'default', paths, encryptedPassword: 'enc' });
    return JSON.parse(fs.readFileSync(buildProfilePath, 'utf-8'));
  };

  it('adds the config, points the product at it, and keeps everything else', () => {
    const written = write({
      app: {
        signingConfigs: [{ name: 'other', material: { certpath: './keep.cer' } }],
        products: [{ name: 'default', compileSdkVersion: '5.0.5(17)' }, { name: 'other', signingConfig: 'other' }],
      },
    });
    expect(written.app.signingConfigs).toEqual([
      { name: 'other', material: { certpath: './keep.cer' } },
      {
        name: 'default',
        type: 'HarmonyOS',
        material: {
          certpath: paths.cerPath,
          keyAlias: 'debugKey',
          keyPassword: 'enc',
          profile: paths.profilePath,
          signAlg: 'SHA256withECDSA',
          storeFile: paths.p12Path,
          storePassword: 'enc',
        },
      },
    ]);
    expect(written.app.products).toEqual([
      { name: 'default', compileSdkVersion: '5.0.5(17)', signingConfig: 'default' },
      { name: 'other', signingConfig: 'other' },
    ]);
  });

  it('replaces a previous config of the same name', () => {
    const written = write({ app: { signingConfigs: [{ name: 'default', type: 'HarmonyOS', material: {} }] } });
    expect(written.app.signingConfigs).toHaveLength(1);
    expect(written.app.signingConfigs[0].material.certpath).toBe(paths.cerPath);
  });
});

describe('collectAclPermissions', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-acl-'));
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ modules: [{ name: 'entry', srcPath: './entry' }] }),
    );
    fs.mkdirSync(path.join(projectDir, 'entry', 'src', 'main'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const writeModule = (sourceSet: string, permissions: string[]): void => {
    const dir = path.join(projectDir, 'entry', 'src', sourceSet);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'module.json5'),
      JSON.stringify({ module: { requestPermissions: permissions.map((name) => ({ name })) } }),
    );
  };

  it('returns only ACL-gated permissions', () => {
    writeModule('main', ['ohos.permission.READ_CONTACTS', 'ohos.permission.INTERNET']);
    // INTERNET is a normal permission and needs no profile entry.
    expect(collectAclPermissions(projectDir)).toEqual(['ohos.permission.READ_CONTACTS']);
  });

  it('includes the ohosTest source set', () => {
    writeModule('main', []);
    writeModule('ohosTest', ['ohos.permission.READ_CONTACTS']);
    expect(collectAclPermissions(projectDir)).toEqual(['ohos.permission.READ_CONTACTS']);
  });

  it('deduplicates and sorts', () => {
    writeModule('main', ['ohos.permission.WRITE_CONTACTS', 'ohos.permission.READ_CONTACTS']);
    writeModule('ohosTest', ['ohos.permission.READ_CONTACTS']);
    expect(collectAclPermissions(projectDir)).toEqual([
      'ohos.permission.READ_CONTACTS',
      'ohos.permission.WRITE_CONTACTS',
    ]);
  });

  it('is empty when nothing is requested', () => {
    writeModule('main', []);
    expect(collectAclPermissions(projectDir)).toEqual([]);
  });
});
