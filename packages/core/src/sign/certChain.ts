import { X509Certificate } from 'node:crypto';

/** One certificate of a signing chain, in a form fit for printing and JSON. */
export interface CertificateInfo {
  /** `CN=…, OU=…, O=…, C=…`, most specific first, as Java and openssl print it. */
  subject: string;
  issuer: string;
  /** The subject's common name, unescaped. */
  commonName?: string;
  notBefore: Date;
  notAfter: Date;
  /** SHA-256 fingerprint, colon-separated hex. */
  fingerprint256: string;
  selfSigned: boolean;
}

/** The certificates of a PEM bundle, in file order. Blocks that do not parse are skipped. */
export function readPemCertificates(text: string): X509Certificate[] {
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return pems.flatMap((pem) => {
    try {
      return [new X509Certificate(pem)];
    } catch {
      return [];
    }
  });
}

/**
 * The certificates leaf first, each followed by its issuer, whatever order the
 * file had them in: hap-sign-tool writes a HAP's chain in signing-block order
 * (an AGC one as root, leaf, intermediate), the SDK's PEMs root first. A
 * certificate that is in no chain from the leaf is appended at the end.
 */
export function orderChain(certs: readonly X509Certificate[]): X509Certificate[] {
  const isIssuerOfAnother = (c: X509Certificate) => certs.some((o) => o !== c && o.issuer === c.subject);
  const leaf = certs.find((c) => !isIssuerOfAnother(c) && c.subject !== c.issuer) ?? certs.find((c) => !c.ca) ?? certs[0];
  if (!leaf) return [];
  const ordered = [leaf];
  for (let cur = leaf; cur.issuer !== cur.subject; ) {
    const next = certs.find((c) => !ordered.includes(c) && c.subject === cur.issuer);
    if (!next) break;
    ordered.push(next);
    cur = next;
  }
  return [...ordered, ...certs.filter((c) => !ordered.includes(c))];
}

/** Node prints a DN one attribute per line, least specific first, with RFC 4514 escapes doubled. */
function formatName(name: string): string {
  return name
    .split('\n')
    .filter(Boolean)
    .reverse()
    .map(unescapeDn)
    .join(', ');
}

function unescapeDn(value: string): string {
  return value.replace(/\\+([,+"\\<>;=#])/g, '$1');
}

export function commonNameOf(name: string): string | undefined {
  const line = name.split('\n').find((l) => l.startsWith('CN='));
  return line ? unescapeDn(line.slice(3)) : undefined;
}

export function describeCertificate(cert: X509Certificate): CertificateInfo {
  return {
    subject: formatName(cert.subject),
    issuer: formatName(cert.issuer),
    commonName: commonNameOf(cert.subject),
    notBefore: new Date(cert.validFrom),
    notAfter: new Date(cert.validTo),
    fingerprint256: cert.fingerprint256,
    selfSigned: cert.subject === cert.issuer,
  };
}

/** The leaf certificate of a PEM bundle, or null when it holds none. */
export function leafCertificateOf(text: string): X509Certificate | null {
  return orderChain(readPemCertificates(text))[0] ?? null;
}
