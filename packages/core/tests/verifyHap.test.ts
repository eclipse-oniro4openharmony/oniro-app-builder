import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { formatHapVerification, verifyHap, verifyHapExitCode } from '../src/sign/verifyHap.js';
import { describeCertificate, leafCertificateOf, orderChain, readPemCertificates } from '../src/sign/certChain.js';
import { describeSigningMaterial, summarizeSigningMaterial } from '../src/sign/generateSigningConfigs.js';
import { describeProfileValidity, formatUtc, parseProvisionProfile } from '../src/harmonyos/signing/profile.js';
import { staticConfig } from '../src/ports/config.js';
import { makeStoredZip } from './_helpers/storedZip.js';

// Throwaway certificate chains, generated per run: no real key or certificate is used.
interface Issued {
  pem: string;
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}

let serial = 1;
function issue(opts: {
  cn: string;
  org: string;
  issuer?: Issued;
  ca: boolean;
  notBefore?: Date;
  notAfter?: Date;
}): Issued {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = (serial++).toString(16).padStart(2, '0');
  cert.validity.notBefore = opts.notBefore ?? new Date('2020-01-01T00:00:00Z');
  cert.validity.notAfter = opts.notAfter ?? new Date('2049-12-31T00:00:00Z');
  const name = [
    { shortName: 'C', value: 'CN' },
    { shortName: 'O', value: opts.org },
    { shortName: 'CN', value: opts.cn },
  ];
  cert.setSubject(name);
  cert.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : name);
  cert.setExtensions([{ name: 'basicConstraints', cA: opts.ca }]);
  cert.sign(opts.issuer?.key ?? keys.privateKey, forge.md.sha256.create());
  return { pem: forge.pki.certificateToPem(cert), cert, key: keys.privateKey };
}

/** A fake `.p7b`: DER-ish noise around the plain-text profile JSON, as the real one carries it. */
function fakeProfile(payload: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x04, 0x01, 0x06, 0x09]), Buffer.from(JSON.stringify(payload)), Buffer.from([0, 1, 2])]);
}

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const NOW = new Date('2026-09-24T12:00:00Z');

let agc: { root: Issued; ca: Issued; leaf: Issued; other: Issued };
let ohos: { root: Issued; ca: Issued; leaf: Issued };

beforeAll(() => {
  const root = issue({ cn: 'Huawei CBG Root CA G2', org: 'Huawei', ca: true });
  const ca = issue({ cn: 'Huawei CBG Developer Relations CA G2 DRE', org: 'Aspiegel', issuer: root, ca: true });
  const leaf = issue({
    cn: 'Jane Dev(1234),Development',
    org: 'Jane Dev',
    issuer: ca,
    ca: false,
    notBefore: new Date('2026-09-17T12:00:00Z'),
    notAfter: new Date('2026-10-01T11:50:00Z'),
  });
  const other = issue({ cn: 'Someone Else,Development', org: 'Else', issuer: ca, ca: false });
  agc = { root, ca, leaf, other };
  const ohRoot = issue({ cn: 'OpenHarmony Application Root CA', org: 'OpenHarmony', ca: true });
  const ohCa = issue({ cn: 'OpenHarmony Application CA', org: 'OpenHarmony', issuer: ohRoot, ca: true });
  const ohLeaf = issue({ cn: 'OpenHarmony Application Profile Release', org: 'OpenHarmony', issuer: ohCa, ca: false });
  ohos = { root: ohRoot, ca: ohCa, leaf: ohLeaf };
}, 30_000);

const agcProfile = (over: Record<string, unknown> = {}) => ({
  'version-name': '2.0.0',
  type: 'debug',
  issuer: 'app_gallery',
  validity: { 'not-before': epoch('2026-09-17T12:00:00Z'), 'not-after': epoch('2026-10-01T11:50:00Z') },
  'bundle-info': {
    'developer-id': '1234',
    'development-certificate': agc.leaf.pem,
    'bundle-name': 'com.example.signed',
    apl: 'normal',
    'app-feature': 'hos_normal_app',
  },
  'debug-info': { 'device-id-type': 'udid', 'device-ids': ['aa'.repeat(32), 'bb'.repeat(32)] },
  ...over,
});

const ohosProfile = () => ({
  'version-name': '2.0.0',
  type: 'release',
  issuer: 'pki_internal',
  validity: { 'not-before': 1594865258, 'not-after': 1689473258 },
  'bundle-info': {
    'developer-id': 'OpenHarmony',
    'distribution-certificate': ohos.leaf.pem,
    'bundle-name': 'com.example.signed',
    apl: 'normal',
    'app-feature': 'hos_normal_app',
  },
});

describe.skipIf(process.platform === 'win32')('verifyHap against a stand-in hap-sign-tool', () => {
  let tmp: string;
  let hapPath: string;
  let config: ReturnType<typeof staticConfig>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-verify-test-'));
    hapPath = path.join(tmp, 'entry-default-signed.hap');
    writeHap({ bundleName: 'com.example.signed', compileSdkType: 'HarmonyOS' });
    // Nothing installed: each test that needs a tool passes its own.
    config = staticConfig({ sdkRootDir: path.join(tmp, 'no-sdk'), cmdToolsPath: path.join(tmp, 'no-tools') });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeHap(app: Record<string, unknown>): void {
    fs.writeFileSync(hapPath, makeStoredZip([{ name: 'module.json', data: Buffer.from(JSON.stringify({ app, module: { name: 'entry' } })) }]));
  }

  /**
   * A `java` that plays `hap-sign-tool verify-app`: writes `chain` and `profile` to
   * -outCertChain and -outProfile and succeeds, or prints the tool's refusal.
   */
  function standIn(behaviour: { chain?: string; profile?: Buffer } | 'unsigned' | 'tampered'): { java: string; signTool: string } {
    const java = path.join(tmp, 'java');
    const lines = ['#!/bin/sh', `echo "$*" > "${tmp}/argv.log"`];
    if (behaviour === 'unsigned') {
      lines.push(
        'echo "11-05 12:38:58.462  ERROR - Verify Hap failed, signature not found."',
        'echo "11-05 12:38:58.462  ERROR - verify: No Hap Signing Block before ZIP Central Directory"',
        'echo "11-05 12:38:58.463  INFO - verify-app failed"',
        'exit 1',
      );
    } else if (behaviour === 'tampered') {
      lines.push('echo "11-05 12:38:58.462  ERROR - verify: Digest verify result: false" >&2', 'exit 1');
    } else {
      fs.writeFileSync(path.join(tmp, 'chain.src'), behaviour.chain ?? '');
      if (behaviour.profile) fs.writeFileSync(path.join(tmp, 'profile.src'), behaviour.profile);
      lines.push(
        'prev=""; for a in "$@"; do',
        `  [ "$prev" = "-outCertChain" ] && cp "${tmp}/chain.src" "$a"`,
        behaviour.profile ? `  [ "$prev" = "-outProfile" ] && cp "${tmp}/profile.src" "$a"` : '  :',
        '  prev="$a"',
        'done',
        'echo "11-05 12:38:37.469  INFO - verify-app success"',
      );
    }
    fs.writeFileSync(java, `${lines.join('\n')}\n`, { mode: 0o755 });
    const signTool = path.join(tmp, 'hap-sign-tool.jar');
    fs.writeFileSync(signTool, '');
    return { java, signTool };
  }

  const verify = (tool: { java: string; signTool: string }, now = NOW) => verifyHap({ hapPath, config, now, ...tool });

  it('reports an AGC-signed HAP: chain leaf first, root, profile and days left', async () => {
    // hap-sign-tool writes an AGC chain root, leaf, intermediate.
    const tool = standIn({ chain: agc.root.pem + agc.leaf.pem + agc.ca.pem, profile: fakeProfile(agcProfile()) });
    const result = await verify(tool);
    expect(result).toMatchObject({
      status: 'valid',
      signed: true,
      signatureValid: true,
      signer: 'harmonyos-agc',
      root: 'Huawei CBG Root CA G2',
      hapBundleName: 'com.example.signed',
      problems: [],
      profile: {
        type: 'debug',
        issuer: 'app_gallery',
        bundleName: 'com.example.signed',
        apl: 'normal',
        appFeature: 'hos_normal_app',
        deviceCount: 2,
        expired: false,
        daysLeft: 6,
        expiryEnforced: true,
        issuedForSigningCertificate: true,
      },
    });
    expect(result.chain.map((c) => c.commonName)).toEqual([
      'Jane Dev(1234),Development',
      'Huawei CBG Developer Relations CA G2 DRE',
      'Huawei CBG Root CA G2',
    ]);
    expect(result.chain[0]!.subject).toBe('CN=Jane Dev(1234),Development, O=Jane Dev, C=CN');
    expect(result.profile!.notAfter).toEqual(new Date('2026-10-01T11:50:00Z'));
    expect(verifyHapExitCode(result)).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'argv.log'), 'utf8').trim()).toMatch(
      new RegExp(`^-jar ${tool.signTool} verify-app -inFile ${hapPath} -outCertChain \\S+\\.cer -outProfile \\S+\\.p7b$`),
    );

    const text = formatHapVerification(result);
    expect(text).toContain(`${hapPath}: valid`);
    expect(text).toContain('HarmonyOS, issued by AppGallery Connect (chains to Huawei CBG Root CA G2)');
    expect(text).toContain('Huawei CBG Root CA G2  [root, until 2049-12-31 00:00 UTC]');
    expect(text).toContain('validity:     2026-09-17 12:00 UTC to 2026-10-01 11:50 UTC, 6 days left');
    expect(text).toContain('devices:      2');
  });

  it('fails a HAP whose AGC profile and certificate have expired', async () => {
    const tool = standIn({ chain: agc.root.pem + agc.leaf.pem + agc.ca.pem, profile: fakeProfile(agcProfile()) });
    const result = await verify(tool, new Date('2026-10-05T00:00:00Z'));
    expect(result.status).toBe('invalid');
    expect(result.profile).toMatchObject({ expired: true, daysLeft: -3 });
    expect(result.problems).toEqual([
      'certificate "Jane Dev(1234),Development" expired on 2026-10-01 11:50 UTC',
      'the debug profile expired on 2026-10-01 11:50 UTC',
    ]);
    expect(verifyHapExitCode(result)).toBe(1);
    expect(formatHapVerification(result)).toContain(': INVALID\n');
    expect(formatHapVerification(result)).toContain('expired 3 days ago');
  });

  it('accepts OpenHarmony development material, whose expired profile window is not enforced', async () => {
    writeHap({ bundleName: 'com.example.signed', compileSdkType: 'OpenHarmony' });
    // The SDK's PEM, as signing uses it, is root first.
    const tool = standIn({ chain: ohos.leaf.pem + ohos.root.pem + ohos.ca.pem, profile: fakeProfile(ohosProfile()) });
    const result = await verify(tool);
    expect(result).toMatchObject({
      status: 'valid',
      signer: 'openharmony-dev',
      root: 'OpenHarmony Application Root CA',
      profile: { type: 'release', issuer: 'pki_internal', expired: true, expiryEnforced: false, deviceCount: 0, issuedForSigningCertificate: true },
    });
    expect(result.notes).toEqual([expect.stringMatching(/do not enforce the validity window .* 2023-07-16 02:07 UTC/)]);
    const text = formatHapVerification(result);
    expect(text).toContain('OpenHarmony development material');
    expect(text).toContain('devices:      any (release profile)');
    expect(text).toContain('(not enforced)');
  });

  it('flags a HarmonyOS HAP signed with OpenHarmony development material', async () => {
    const tool = standIn({ chain: ohos.root.pem + ohos.ca.pem + ohos.leaf.pem, profile: fakeProfile(ohosProfile()) });
    const result = await verify(tool);
    expect(result.status).toBe('invalid');
    expect(result.problems).toEqual([expect.stringMatching(/built for HarmonyOS but signed with OpenHarmony development material/)]);
  });

  it('flags a profile issued for another certificate, or for another bundle', async () => {
    const profile = agcProfile({
      'bundle-info': { ...agcProfile()['bundle-info'], 'development-certificate': agc.other.pem, 'bundle-name': 'com.example.other' },
    });
    const result = await verify(standIn({ chain: agc.leaf.pem + agc.ca.pem + agc.root.pem, profile: fakeProfile(profile) }));
    expect(result.status).toBe('invalid');
    expect(result.profile!.issuedForSigningCertificate).toBe(false);
    expect(result.problems).toEqual([
      'the profile was issued for certificate "Someone Else,Development", not "Jane Dev(1234),Development", which signed the HAP',
      'the profile is for bundle com.example.other, but the HAP is com.example.signed',
    ]);
  });

  it('flags a chain whose links do not verify, and notes one that stops below its root', async () => {
    // `forged` claims the real intermediate as issuer but is signed by another key.
    const impostor = issue({ cn: 'Huawei CBG Developer Relations CA G2 DRE', org: 'Aspiegel', ca: true });
    const forged = issue({ cn: 'Jane Dev(1234),Development', org: 'Jane Dev', issuer: impostor, ca: false });
    const result = await verify(standIn({ chain: forged.pem + agc.ca.pem, profile: fakeProfile(agcProfile({ 'bundle-info': {} })) }));
    expect(result.problems).toContain('certificate "Jane Dev(1234),Development" does not verify against its issuer\'s key');
    expect(result.root).toBe('Huawei CBG Root CA G2');
    expect(result.notes).toContain('the chain stops below its root, Huawei CBG Root CA G2');
  });

  it('reports an unsigned HAP as invalid, with the tool\'s reason', async () => {
    const result = await verify(standIn('unsigned'));
    expect(result).toMatchObject({ status: 'invalid', signed: false, signatureValid: false, chain: [] });
    expect(result.problems).toEqual(['the HAP is not signed: it has no signing block']);
    expect(result.toolErrors).toEqual([
      'Verify Hap failed, signature not found.',
      'verify: No Hap Signing Block before ZIP Central Directory',
    ]);
    expect(verifyHapExitCode(result)).toBe(1);
    expect(formatHapVerification(result)).toContain('signature:    none (unsigned)');
  });

  it('reports a signature the tool rejects', async () => {
    const result = await verify(standIn('tampered'));
    expect(result).toMatchObject({ status: 'invalid', signed: true, signatureValid: false });
    expect(result.problems).toEqual(['hap-sign-tool rejected the signature: verify: Digest verify result: false']);
  });

  it('could not verify without hap-sign-tool, a java, or the HAP', async () => {
    let result = await verifyHap({ hapPath, config });
    expect(result.status).toBe('unverified');
    expect(result.problems).toEqual([expect.stringMatching(/no hap-sign-tool\.jar found/)]);
    expect(verifyHapExitCode(result)).toBe(2);

    result = await verifyHap({ hapPath, config, signTool: '/x.jar', java: path.join(tmp, 'no-java') });
    expect(result.status).toBe('unverified');
    expect(result.problems).toEqual([expect.stringMatching(/could not run hap-sign-tool/)]);

    result = await verifyHap({ hapPath: path.join(tmp, 'absent.hap'), config, ...standIn('unsigned') });
    expect(result).toMatchObject({ status: 'unverified', problems: [expect.stringMatching(/absent\.hap does not exist/)] });
    expect(formatHapVerification(result)).toContain(': could not verify');
  });

  it("finds the OpenHarmony SDK's hap-sign-tool by itself", async () => {
    const lib = path.join(tmp, 'sdk', process.platform === 'darwin' ? 'darwin' : 'linux', '20', 'toolchains', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'hap-sign-tool.jar'), '');
    const { java } = standIn('unsigned');
    await verifyHap({ hapPath, config: staticConfig({ sdkRootDir: path.join(tmp, 'sdk'), cmdToolsPath: path.join(tmp, 'no-tools') }), java });
    expect(fs.readFileSync(path.join(tmp, 'argv.log'), 'utf8')).toContain(`-jar ${path.join(lib, 'hap-sign-tool.jar')} verify-app`);
  });
});

describe('certificate chains', () => {
  it('orders any arrangement leaf first, and names subjects most specific first', () => {
    const certs = readPemCertificates(`junk\n${agc.ca.pem}${agc.root.pem}${agc.leaf.pem}`);
    const ordered = orderChain(certs).map(describeCertificate);
    expect(ordered.map((c) => c.commonName)).toEqual([
      'Jane Dev(1234),Development',
      'Huawei CBG Developer Relations CA G2 DRE',
      'Huawei CBG Root CA G2',
    ]);
    expect(ordered[2]).toMatchObject({ subject: 'CN=Huawei CBG Root CA G2, O=Huawei, C=CN', selfSigned: true });
    expect(ordered[0]!.notAfter).toEqual(new Date('2026-10-01T11:50:00Z'));
    expect(leafCertificateOf(ohos.root.pem + ohos.ca.pem + ohos.leaf.pem)?.subject).toContain('Profile Release');
    expect(orderChain([])).toEqual([]);
  });
});

describe('profile summaries', () => {
  it('formats times as minutes in UTC', () => {
    expect(formatUtc(new Date('2026-10-01T11:50:59.999Z'))).toBe('2026-10-01 11:50 UTC');
  });

  it('names the type and expiry, as `sign` prints them', () => {
    const notAfter = new Date('2026-10-01T11:50:00Z');
    expect(describeProfileValidity({ type: 'debug', notAfter }, NOW)).toBe('debug, valid until 2026-10-01 11:50 UTC');
    expect(describeProfileValidity({ type: 'debug', notAfter }, new Date('2026-10-02T00:00:00Z'))).toBe(
      'debug, expired 2026-10-01 11:50 UTC',
    );
    expect(describeProfileValidity({})).toBe('');
  });

  it('reads type, issuer, apl, app-feature and both dates from a profile', () => {
    const profile = parseProvisionProfile(fakeProfile(agcProfile()));
    expect(profile).toMatchObject({
      type: 'debug',
      issuer: 'app_gallery',
      apl: 'normal',
      appFeature: 'hos_normal_app',
      notBefore: new Date('2026-09-17T12:00:00Z'),
      notAfter: new Date('2026-10-01T11:50:00Z'),
    });
    expect(parseProvisionProfile(Buffer.from('no profile here'))).toBeNull();
  });

  it("summarizes an OpenHarmony project's signatures directory for `sign`", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sig-summary-'));
    try {
      fs.writeFileSync(path.join(dir, 'app1-profile.p7b'), fakeProfile(ohosProfile()));
      fs.writeFileSync(path.join(dir, 'OpenHarmonyProfileRelease.pem'), ohos.root.pem + ohos.ca.pem + ohos.leaf.pem);
      const summary = summarizeSigningMaterial(dir, 'profile-release');
      expect(summary).toEqual({
        profileType: 'release',
        apl: 'normal',
        profileNotAfter: new Date(1689473258 * 1000),
        certificateNotAfter: new Date(new X509Certificate(ohos.leaf.pem).validTo),
      });
      expect(describeSigningMaterial(summary)).toBe('release profile, apl normal; certificate valid until 2049-12-31 00:00 UTC');
      expect(describeSigningMaterial(summarizeSigningMaterial(path.join(dir, 'absent'), 'application-release'))).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
