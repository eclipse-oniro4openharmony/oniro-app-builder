import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTeamList } from '../src/harmonyos/auth/session.js';
import { HUAWEI_SITES, siteForId } from '../src/harmonyos/auth/endpoints.js';
import { createTokenStore } from '../src/harmonyos/auth/tokenStore.js';
import { startCallbackServer } from '../src/harmonyos/auth/callbackServer.js';
import { openBrowser } from '../src/harmonyos/auth/browser.js';
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
  let authDir: string;

  beforeEach(() => {
    // The key lives under the home directory; keep it out of the real one.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-token-'));
    authDir = path.join(home, 'auth');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const store = () => createTokenStore({ config: staticConfig({ harmonyosAuthDir: authDir }) });
  const keyPath = () => path.join(home, '.local', 'share', 'oniro-app', 'keys', 'kek.bin');

  it('round-trips a session, region included, through encryption', () => {
    const s = store();
    s.save({ jwtToken: 'my.jwt.token', siteId: '7' });
    expect(s.load()).toEqual({ jwtToken: 'my.jwt.token', siteId: '7' });
    // A fresh instance reads it back too.
    expect(store().load()).toEqual({ jwtToken: 'my.jwt.token', siteId: '7' });
  });

  it('does not write the token in the clear, nor next to its key', () => {
    const s = store();
    s.save({ jwtToken: 'super-secret-value', siteId: '1' });
    const onDisk = fs.readFileSync(s.tokenPath, 'utf8');
    expect(onDisk).not.toContain('super-secret-value');
    expect(JSON.parse(onDisk).algorithm).toBe('aes-256-gcm');
    expect(path.dirname(s.tokenPath)).toBe(authDir);
    expect(fs.existsSync(keyPath())).toBe(true);
    expect(fs.readdirSync(authDir)).toEqual(['token.enc']);
  });

  it('returns null before anything is saved', () => {
    expect(store().load()).toBeNull();
  });

  it('clears the token', () => {
    const s = store();
    s.save({ jwtToken: 'token', siteId: '1' });
    s.clear();
    expect(s.load()).toBeNull();
    expect(fs.existsSync(s.tokenPath)).toBe(false);
    expect(() => s.clear()).not.toThrow();
  });

  it('discards a corrupted token rather than throwing on every later call', () => {
    const s = store();
    s.save({ jwtToken: 'token', siteId: '1' });
    fs.writeFileSync(s.tokenPath, '{"algorithm":"aes-256-gcm","ciphertext":"zzz","iv":"zz","authTag":"zz"}');
    expect(s.load()).toBeNull();
    expect(fs.existsSync(s.tokenPath)).toBe(false);
  });

  it('treats a token whose key was lost or damaged as signed out', () => {
    const s = store();
    s.save({ jwtToken: 'token', siteId: '1' });
    fs.writeFileSync(keyPath(), 'short');
    expect(s.load()).toBeNull();
    // A usable key was minted in its place.
    expect(fs.readFileSync(keyPath())).toHaveLength(32);
    s.save({ jwtToken: 'again', siteId: '1' });
    expect(s.load()?.jwtToken).toBe('again');
  });

  it('ignores a token file that is not an encrypted blob', () => {
    const s = store();
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(s.tokenPath, JSON.stringify({ jwtToken: 'plain' }));
    expect(s.load()).toBeNull();
  });

  it('refuses to store an empty token', () => {
    expect(() => store().save({ jwtToken: '', siteId: '1' })).toThrow(OniroError);
  });

  it('writes the token and key 0600, in 0700 directories, on POSIX', () => {
    if (process.platform === 'win32') return;
    const s = store();
    s.save({ jwtToken: 'token', siteId: '1' });
    expect(fs.statSync(s.tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(keyPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(authDir).mode & 0o777).toBe(0o700);
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
  const start = () =>
    startCallbackServer({
      clientSecret: 'secret123',
      baseUrl: 'https://example.invalid',
      successPath: 'ok',
      failedPath: 'fail',
    });

  it('accepts a callback carrying the matching secret, and redirects to the success page', async () => {
    const server = await start();
    try {
      const pending = server.waitForCallback(5_000);
      const res = await fetch(`http://127.0.0.1:${server.port}/callback?code=secret123&tempToken=tok&siteId=1`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://example.invalid/ok');
      await expect(pending).resolves.toEqual({ tempToken: 'tok', siteId: '1' });
    } finally {
      await server.stop();
    }
  });

  it('keeps a callback that arrives before anyone waits for it', async () => {
    // A browser launcher may only return once the browser has already come back.
    const server = await start();
    try {
      await fetch(`http://127.0.0.1:${server.port}/callback?code=secret123&tempToken=early&siteId=5`, {
        redirect: 'manual',
      });
      await expect(server.waitForCallback(1_000)).resolves.toEqual({ tempToken: 'early', siteId: '5' });
    } finally {
      await server.stop();
    }
  });

  it('accepts the callback as a form POST', async () => {
    const server = await start();
    try {
      const pending = server.waitForCallback(5_000);
      await fetch(`http://localhost:${server.port}/callback`, {
        method: 'POST',
        body: new URLSearchParams({ code: 'secret123', tempToken: 'posted', siteId: '7' }),
        redirect: 'manual',
      });
      await expect(pending).resolves.toEqual({ tempToken: 'posted', siteId: '7' });
    } finally {
      await server.stop();
    }
  });

  it('ignores a callback with the wrong secret', async () => {
    const server = await start();
    try {
      // Attach the rejection handler before triggering it, or the rejection lands
      // in the same tick with nothing listening and surfaces as unhandled.
      const settled = expect(server.waitForCallback(300)).rejects.toThrow(/Timed out/);
      const res = await fetch(`http://127.0.0.1:${server.port}/callback?code=wrong&tempToken=tok&siteId=1`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
      // The forged callback must not resolve the login; it times out instead.
      await settled;
    } finally {
      await server.stop();
    }
  });

  it('rejects a callback missing the token or region', async () => {
    const server = await start();
    try {
      for (const query of ['code=secret123&siteId=1', 'code=secret123&tempToken=tok']) {
        const res = await fetch(`http://127.0.0.1:${server.port}/callback?${query}`, { redirect: 'manual' });
        expect(res.status).toBe(400);
      }
      await expect(server.waitForCallback(100)).rejects.toThrow(/Timed out/);
    } finally {
      await server.stop();
    }
  });

  it('refuses requests addressed to another host name', async () => {
    const server = await start();
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        http
          .get(
            {
              host: '127.0.0.1',
              port: server.port,
              path: '/callback?code=secret123&tempToken=tok&siteId=1',
              headers: { host: `attacker.example:${server.port}` },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          )
          .on('error', reject);
      });
      expect(status).toBe(400);
      await expect(server.waitForCallback(100)).rejects.toThrow(/Timed out/);
    } finally {
      await server.stop();
    }
  });

  it('rejects when the user quits in the browser, even before anyone waits', async () => {
    const server = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/callback?code=secret123&quit=true`, {
        redirect: 'manual',
      });
      expect(res.headers.get('location')).toBe('https://example.invalid/fail');
      await expect(server.waitForCallback(5_000)).rejects.toThrow(/cancelled/i);
    } finally {
      await server.stop();
    }
  });

  it('404s any path other than /callback', async () => {
    const server = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/elsewhere`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe('openBrowser', () => {
  it('refuses anything but a plain http(s) URL, before launching anything', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'https://example.com/"&calc']) {
      await expect(openBrowser(url)).rejects.toThrow(/Refusing to open unsafe URL/);
    }
  });
});
