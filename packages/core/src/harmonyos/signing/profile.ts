/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/signature/generate-profile.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import * as fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { AgcError, SIGNING_ERRORS } from './errors.js';

/** The fields of a provisioning profile that decide whether it can be reused. */
export interface ProvisionProfileInfo {
  bundleName?: string;
  /** The AGC team the profile was issued to. */
  developerId?: string;
  notAfter?: Date;
  /** Uppercased UDIDs the debug profile is valid for. */
  deviceIds: string[];
  aclPermissions: string[];
  /** PEM of the certificate the profile was issued for. */
  developmentCertificate?: string;
}

/**
 * The JSON payload of a `.p7b` profile. The file is PKCS#7 signed data carrying
 * the JSON in the clear, so it is found by scanning for the balanced object that
 * has `bundle-info` — node-forge cannot parse the EC certificates around it.
 *
 * @internal exposed for tests.
 */
export function extractProfileJson(buffer: Buffer): string | null {
  const text = buffer.toString('latin1');
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (escaped) escaped = false;
      else if (inString) {
        if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        // The payload is UTF-8; re-decode so non-ASCII survives.
        const json = Buffer.from(text.slice(start, i + 1), 'latin1').toString('utf8');
        try {
          if ('bundle-info' in (JSON.parse(json) as object)) return json;
        } catch {
          // Some other brace pair in the binary framing; keep scanning.
        }
        break;
      }
    }
  }
  return null;
}

/** Read a `.p7b` profile; null when it is missing or unreadable, which means "regenerate". */
export function readProvisionProfile(profilePath: string): ProvisionProfileInfo | null {
  let raw: {
    validity?: { 'not-after'?: unknown };
    'bundle-info'?: { 'bundle-name'?: unknown; 'developer-id'?: unknown; 'development-certificate'?: unknown };
    'debug-info'?: { 'device-ids'?: unknown };
    acls?: { 'allowed-acls'?: unknown };
  };
  try {
    const json = extractProfileJson(fs.readFileSync(profilePath));
    if (!json) return null;
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const notAfter = raw.validity?.['not-after'];
  const bundle = raw['bundle-info'] ?? {};
  return {
    bundleName: str(bundle['bundle-name']),
    developerId: str(bundle['developer-id']),
    // Epoch seconds.
    notAfter: typeof notAfter === 'number' ? new Date(notAfter * 1000) : undefined,
    deviceIds: strings(raw['debug-info']?.['device-ids']).map((d) => d.toUpperCase()),
    aclPermissions: strings(raw.acls?.['allowed-acls']),
    developmentCertificate: str(bundle['development-certificate']),
  };
}

function parseCertificate(pem: string): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    throw new AgcError(SIGNING_ERRORS.CERT_INVALID);
  }
}

/**
 * Whether the p12 holds the key `certificate` certifies, by comparing public keys.
 *
 * node-forge reads the PKCS#12 container, which Node cannot. Not the certificate
 * inside it, though: forge parses only RSA certificates, and hap-sign-tool makes
 * ECC keys, so forge hands back the raw ASN.1 for Node's X.509 parser. Any read
 * failure, a wrong password included, is "no".
 *
 * @internal exposed for tests.
 */
export function keystoreHoldsKey(
  p12Path: string,
  keyAlias: string,
  keyPwd: string,
  certificate: X509Certificate,
): boolean {
  try {
    const der = forge.util.createBuffer(fs.readFileSync(p12Path).toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), keyPwd);
    const certBag = forge.pki.oids.certBag ?? '1.2.840.113549.1.12.10.1.3';
    const wanted = certificate.publicKey.export({ type: 'spki', format: 'der' });
    return (p12.getBags({ bagType: certBag })[certBag] ?? []).some((bag) => {
      if (bag.attributes?.friendlyName?.[0]?.toLowerCase() !== keyAlias.toLowerCase()) return false;
      const asn1 = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : bag.asn1;
      if (!asn1) return false;
      const bagCert = new X509Certificate(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));
      return bagCert.publicKey.export({ type: 'spki', format: 'der' }).equals(wanted);
    });
  } catch {
    return false;
  }
}

/**
 * Check that the downloaded certificate chain is in date, that the profile was
 * issued for its leaf certificate, and that the keystore holds the certified key.
 * A mismatch here would otherwise surface much later, as an install failure.
 */
export function verifySigningMaterial(opts: {
  profilePath: string;
  cerPath: string;
  p12Path: string;
  keyAlias: string;
  keyPwd: string;
  now?: Date;
}): void {
  const pems = fs.readFileSync(opts.cerPath, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  const chain = (pems ?? []).map(parseCertificate);
  const leaf = chain.find((c) => !c.ca) ?? chain.at(-1);
  if (!leaf) throw new AgcError(SIGNING_ERRORS.CERT_INVALID);

  const now = opts.now ?? new Date();
  if (chain.some((c) => now < new Date(c.validFrom) || now > new Date(c.validTo))) {
    throw new AgcError(SIGNING_ERRORS.CERT_EXPIRED);
  }

  const issuedFor = readProvisionProfile(opts.profilePath)?.developmentCertificate;
  if (!issuedFor || parseCertificate(issuedFor).fingerprint256 !== leaf.fingerprint256) {
    throw new AgcError(SIGNING_ERRORS.CERT_PROFILE_MISMATCH);
  }
  if (!keystoreHoldsKey(opts.p12Path, opts.keyAlias, opts.keyPwd, leaf)) {
    throw new AgcError(SIGNING_ERRORS.KEYSTORE_CERT_MISMATCH);
  }
}
