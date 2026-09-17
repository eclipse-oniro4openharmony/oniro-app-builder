import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTeamList } from '../src/harmonyos/auth/session.js';
import { HUAWEI_SITES, siteForId } from '../src/harmonyos/auth/endpoints.js';
import { createTokenStore } from '../src/harmonyos/auth/tokenStore.js';
import { startCallbackServer } from '../src/harmonyos/auth/callbackServer.js';
import { previewBody, proxyForUrl, redactUrl } from '../src/harmonyos/http.js';
import { staticConfig } from '../src/ports/config.js';
import { OniroError } from '../src/ports/errors.js';

describe('parseTeamList', () => {
  it('maps the AGC team payload', () => {
    const body = JSON.stringify({ ret: { code: 0 }, teams: [{ id: 't1', name: 'Team One', countryCode: 'CN' }] });
    expect(parseTeamList(body)).toEqual([{ id: 't1', name: 'Team One' }]);
  });

  it('raises a non-zero ret.code even though the HTTP status was 200', () => {
    expect(() => parseTeamList(JSON.stringify({ ret: { code: 403, msg: 'no permission' } }))).toThrow(
      /no permission/,
    );
  });

  it('drops entries with no id', () => {
    const teams = parseTeamList(JSON.stringify({ teams: [{ name: 'nameless' }, { id: 'ok' }] }));
    expect(teams.map((t) => t.id)).toEqual(['ok']);
  });

  it('returns an empty list for unusable bodies', () => {
    expect(parseTeamList('not json')).toEqual([]);
    expect(parseTeamList(JSON.stringify({}))).toEqual([]);
    expect(parseTeamList(JSON.stringify({ teams: 'nope' }))).toEqual([]);
  });
});

describe('token store', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-token-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const store = () => createTokenStore({ config: staticConfig({ harmonyosAuthDir: home }) });

  it('round-trips a session through encryption', () => {
    const s = store();
    s.save({ jwtToken: 'my.jwt.token', siteId: '7' });
    expect(s.load()).toEqual({ jwtToken: 'my.jwt.token', siteId: '7' });
  });

  it('remembers the region, so later calls reach the right hosts', () => {
    const s = store();
    s.save({ jwtToken: 'a.b.c', siteId: '7' });
    expect(s.load()?.siteId).toBe('7');
  });

  it('does not write the token in the clear', () => {
    const s = store();
    s.save({ jwtToken: 'super-secret-value', siteId: '1' });
    const onDisk = fs.readFileSync(s.tokenPath, 'utf8');
    expect(onDisk).not.toContain('super-secret-value');
    expect(JSON.parse(onDisk).algorithm).toBe('aes-256-gcm');
  });

  it('returns null before anything is saved', () => {
    expect(store().load()).toBeNull();
  });

  it('clears the token and the wrapped key', () => {
    const s = store();
    s.save({ jwtToken: 'token', siteId: '1' });
    s.clear();
    expect(s.load()).toBeNull();
    expect(fs.existsSync(s.tokenPath)).toBe(false);
  });

  it('discards a corrupted token rather than throwing on every later call', () => {
    const s = store();
    s.save({ jwtToken: 'token', siteId: '1' });
    fs.writeFileSync(s.tokenPath, '{"algorithm":"aes-256-gcm","ciphertext":"zzz","iv":"zz","authTag":"zz"}');
    expect(s.load()).toBeNull();
  });

  it('refuses to store an empty token', () => {
    expect(() => store().save({ jwtToken: '', siteId: '1' })).toThrow(OniroError);
  });

  it('writes the token file 0600 on POSIX', () => {
    if (process.platform === 'win32') return;
    const s = store();
    s.save({ jwtToken: 'token', siteId: '1' });
    expect(fs.statSync(s.tokenPath).mode & 0o777).toBe(0o600);
  });
});

describe('Huawei regions', () => {
  const codes = ['CN', 'SG', 'EU', 'RU'] as const;

  it('maps each siteId to its region', () => {
    expect(['1', '5', '7', '8'].map((id) => siteForId(id)?.code)).toEqual(codes);
  });

  it('does not guess a region for an unknown siteId', () => {
    // A token sent to another region's hosts is refused, so there is no safe default.
    expect(siteForId('999')).toBeNull();
  });

  it('sends DE, not EU, as the European token-exchange site', () => {
    // The token endpoint refuses `site=EU` with the same empty 200 it gives a garbage token.
    expect(codes.map((c) => HUAWEI_SITES[c].siteParam)).toEqual(['CN', 'SG', 'DE', 'RU']);
  });

  it('gives every region its own sign-in and signing hosts', () => {
    // The unprefixed devecostudio.huawei.com is hosted in China and does not
    // redeem other regions' tokens.
    for (const key of ['loginUrl', 'agcBaseUrl'] as const) {
      const hosts = codes.map((c) => HUAWEI_SITES[c][key]);
      expect(new Set(hosts).size).toBe(hosts.length);
    }
    expect(HUAWEI_SITES.EU.loginUrl).toBe('https://de.devecostudio.huawei.com');
    expect(HUAWEI_SITES.EU.agcBaseUrl).toBe('https://connect-api-dre.cloud.huawei.com');
  });
});

describe('login callback server', () => {
  it('accepts a callback carrying the matching secret', async () => {
    const server = await startCallbackServer({
      clientSecret: 'secret123',
      baseUrl: 'https://example.invalid',
      successPath: 'ok',
      failedPath: 'fail',
    });
    try {
      const pending = server.waitForCallback(5_000);
      await fetch(
        `http://127.0.0.1:${server.port}/callback?code=secret123&tempToken=tok&siteId=1`,
        { redirect: 'manual' },
      );
      await expect(pending).resolves.toMatchObject({ tempToken: 'tok', siteId: '1' });
    } finally {
      await server.stop();
    }
  });

  it('ignores a callback with the wrong secret', async () => {
    const server = await startCallbackServer({
      clientSecret: 'secret123',
      baseUrl: 'https://example.invalid',
      successPath: 'ok',
      failedPath: 'fail',
    });
    try {
      // Attach the rejection handler before triggering it, or the rejection lands
      // in the same tick with nothing listening and surfaces as unhandled.
      const settled = expect(server.waitForCallback(300)).rejects.toThrow(/Timed out/);
      const res = await fetch(
        `http://127.0.0.1:${server.port}/callback?code=wrong&tempToken=tok&siteId=1`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(400);
      // The forged callback must not resolve the login; it times out instead.
      await settled;
    } finally {
      await server.stop();
    }
  });

  it('rejects when the user quits in the browser', async () => {
    const server = await startCallbackServer({
      clientSecret: 'secret123',
      baseUrl: 'https://example.invalid',
      successPath: 'ok',
      failedPath: 'fail',
    });
    try {
      const settled = expect(server.waitForCallback(5_000)).rejects.toThrow(/cancelled/i);
      await fetch(`http://127.0.0.1:${server.port}/callback?code=secret123&quit=true`, {
        redirect: 'manual',
      });
      await settled;
    } finally {
      await server.stop();
    }
  });

  it('404s any path other than /callback', async () => {
    const server = await startCallbackServer({
      clientSecret: 'secret123',
      baseUrl: 'https://example.invalid',
      successPath: 'ok',
      failedPath: 'fail',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/elsewhere`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe('proxyForUrl', () => {
  it('picks HTTPS_PROXY for https targets', () => {
    expect(proxyForUrl('https://example.com', { HTTPS_PROXY: 'http://proxy:8080' })).toBe('http://proxy:8080');
  });

  it('falls back to HTTP_PROXY for https targets', () => {
    expect(proxyForUrl('https://example.com', { HTTP_PROXY: 'http://proxy:8080' })).toBe('http://proxy:8080');
  });

  it('does not use HTTPS_PROXY for http targets', () => {
    expect(proxyForUrl('http://example.com', { HTTPS_PROXY: 'http://proxy:8080' })).toBeUndefined();
  });

  it('honours NO_PROXY, including subdomains', () => {
    const env = { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'example.com' };
    expect(proxyForUrl('https://example.com', env)).toBeUndefined();
    expect(proxyForUrl('https://api.example.com', env)).toBeUndefined();
    expect(proxyForUrl('https://notexample.com', env)).toBe('http://proxy:8080');
  });

  it('honours a wildcard NO_PROXY', () => {
    expect(proxyForUrl('https://example.com', { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: '*' })).toBeUndefined();
  });

  it('accepts lowercase variable names', () => {
    expect(proxyForUrl('https://example.com', { https_proxy: 'http://proxy:8080' })).toBe('http://proxy:8080');
  });

  it('returns undefined with no proxy configured or a bad URL', () => {
    expect(proxyForUrl('https://example.com', {})).toBeUndefined();
    expect(proxyForUrl('not a url', { HTTPS_PROXY: 'http://proxy:8080' })).toBeUndefined();
  });
});

describe('log redaction', () => {
  it('strips credentials from a URL but keeps the rest legible', () => {
    const redacted = redactUrl(
      'https://h.example/authrouter/auth/api/temptoken/check?tempToken=SECRET&site=EU&appid=1009',
    );
    expect(redacted).not.toContain('SECRET');
    expect(redacted).toContain('tempToken=***');
    expect(redacted).toContain('site=EU');
    expect(redacted).toContain('appid=1009');
  });

  it('strips every sensitive parameter name, case-insensitively', () => {
    const redacted = redactUrl('https://h.example/x?jwtToken=A&code=B&oauth2Token=C&accessToken=D&keep=E');
    for (const secret of ['A', 'B', 'C', 'D']) {
      expect(redacted).not.toContain(`=${secret}&`);
      expect(redacted).not.toContain(`=${secret}`.concat(''));
    }
    expect(redacted).toContain('keep=E');
  });

  it('leaves a non-URL untouched rather than throwing', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });

  it('previews an error body for diagnosis', () => {
    expect(previewBody('<html><title>404 Not Found</title></html>')).toContain('404 Not Found');
    expect(previewBody('')).toBe('(empty body)');
    expect(previewBody('   ')).toBe('(empty body)');
  });

  it('never echoes a token-shaped body', () => {
    // A successful exchange returns a bare JWT; it must not reach an error string.
    expect(previewBody('aaa.bbb.ccc')).toBe('(a token-shaped value)');
  });

  it('truncates long bodies', () => {
    expect(previewBody('x'.repeat(1000)).length).toBeLessThan(320);
  });

  it('collapses newlines so a multi-line page stays one log line', () => {
    expect(previewBody('line one\nline two')).toBe('line one line two');
  });
});
