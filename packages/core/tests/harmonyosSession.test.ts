import { describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import { createHarmonyOsSession } from '../src/harmonyos/auth/session.js';
import { openBrowser } from '../src/harmonyos/auth/browser.js';
import { HUAWEI_SITES } from '../src/harmonyos/auth/endpoints.js';
import type { StoredSession, TokenStore } from '../src/harmonyos/auth/tokenStore.js';
import type {
  HarmonyOsHttpClient,
  HttpRequestOptions,
  HttpResponse,
} from '../src/harmonyos/http.js';
import { staticConfig } from '../src/ports/config.js';
import type { Logger } from '../src/ports/logger.js';

// Never launch a real browser from a test.
vi.mock('../src/harmonyos/auth/browser.js', () => ({ openBrowser: vi.fn(async () => {}) }));

const JWT = 'header.payload.signature';

interface Call {
  url: string;
  opts?: HttpRequestOptions;
}

type Route = (call: Call) => (Partial<HttpResponse> & { throws?: true }) | undefined;

/** HTTP client answering from `route`, recording every GET/POST. Unrouted calls get a 404, `throws` rejects. */
function fakeHttp(route: Route): { http: HarmonyOsHttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = async (url: string, opts?: HttpRequestOptions): Promise<HttpResponse> => {
    calls.push({ url, opts });
    const r = route({ url, opts }) ?? { statusCode: 404 };
    if ('throws' in r) throw new Error('network down');
    return { data: '', statusCode: 200, statusText: '', ...r };
  };
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    calls,
    http: { get: respond, post: respond, delete: unused, getBinary: unused },
  };
}

function memoryStore(initial: StoredSession | null = null): TokenStore {
  let session = initial;
  return {
    tokenPath: '/memory/token.enc',
    save: (s) => {
      session = s;
    },
    load: () => session,
    clear: () => {
      session = null;
    },
  };
}

const tokenCheck = (realName: boolean) => ({
  data: JSON.stringify({
    status: true,
    userInfo: { accessToken: 'at', userId: 'u1', name: 'n', nationalCode: 'IT', realName: String(realName) },
  }),
});

const agreement = (signedFlag: boolean, signLastestFlag: boolean) => ({
  data: JSON.stringify({ code: 200, success: true, body: { signedFlag, signLastestFlag, accessCode: 200 } }),
});

/** Play the browser: come back to the loopback server named in `loginUrl`. */
const callBack = (loginUrl: string, params: string) => {
  const { searchParams } = new URL(loginUrl);
  return fetch(
    `http://127.0.0.1:${searchParams.get('port')}/callback?code=${searchParams.get('code')}&${params}`,
    { redirect: 'manual' },
  );
};

const euLogin: Route = ({ url }) => {
  if (url.endsWith('/temptoken/check')) return { data: JWT };
  if (url.endsWith('/jwToken/check')) return tokenCheck(false);
  return undefined;
};

describe('HarmonyOS session routing', () => {
  it('redeems a European login on the DE host with site=DE', async () => {
    const { http, calls } = fakeHttp(({ url, opts }) => {
      if (url === `${HUAWEI_SITES.EU.loginUrl}/authrouter/auth/api/temptoken/check`) {
        // The real endpoint answers an empty 200 to anything it will not redeem.
        return opts?.query?.site === 'DE' ? { data: JWT } : { data: '' };
      }
      if (url === `${HUAWEI_SITES.EU.loginUrl}/authrouter/auth/api/jwToken/check`) return tokenCheck(false);
      return undefined;
    });
    const store = memoryStore();

    let loginUrl = '';
    const session = createHarmonyOsSession({
      config: staticConfig({}),
      http,
      tokenStore: store,
      onLoginUrl: (u) => {
        loginUrl = u;
      },
    });

    const pending = session.login({ timeoutMs: 5_000 });
    await vi.waitFor(() => expect(loginUrl).not.toBe(''));
    // Sign-in starts on the CN page, which redirects a European account to its
    // own site; the callback reports siteId 7.
    const { searchParams } = new URL(loginUrl);
    await fetch(
      `http://127.0.0.1:${searchParams.get('port')}/callback?code=${searchParams.get('code')}&tempToken=tmp&siteId=7`,
      { redirect: 'manual' },
    );

    await expect(pending).resolves.toMatchObject({ userId: 'u1', siteCode: 'EU' });
    expect(store.load()).toEqual({ jwtToken: JWT, siteId: '7' });
    // Nothing went to the China-hosted auth servers.
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      'de.devecostudio.huawei.com',
      'de.devecostudio.huawei.com',
    ]);
  });

  it('explains a refused token exchange instead of storing a session', async () => {
    const { http } = fakeHttp(() => ({ data: '' }));
    const store = memoryStore();
    let loginUrl = '';
    const session = createHarmonyOsSession({
      config: staticConfig({}),
      http,
      tokenStore: store,
      onLoginUrl: (u) => {
        loginUrl = u;
      },
    });

    const settled = expect(session.login({ timeoutMs: 5_000 })).rejects.toThrow(
      /de\.devecostudio\.huawei\.com would not exchange/,
    );
    await vi.waitFor(() => expect(loginUrl).not.toBe(''));
    const { searchParams } = new URL(loginUrl);
    await fetch(
      `http://127.0.0.1:${searchParams.get('port')}/callback?code=${searchParams.get('code')}&tempToken=tmp&siteId=7`,
      { redirect: 'manual' },
    );
    await settled;
    expect(store.load()).toBeNull();
  });

  it('lists teams from the shared host even for a European account', async () => {
    const { http, calls } = fakeHttp(({ url }) => {
      if (url === `${HUAWEI_SITES.EU.loginUrl}/authrouter/auth/api/jwToken/check`) return tokenCheck(true);
      if (url.endsWith('/user-team-list')) return { data: JSON.stringify({ ret: { code: 0 }, teams: [] }) };
      return undefined;
    });
    const session = createHarmonyOsSession({
      config: staticConfig({}),
      http,
      tokenStore: memoryStore({ jwtToken: JWT, siteId: '7' }),
    });

    await session.listTeams();
    expect(calls.find((c) => c.url.endsWith('/user-team-list'))?.url).toBe(
      'https://connect-api.cloud.huawei.com/api/ups/user-permission-service/v1/user-team-list',
    );
  });
});

describe('signing eligibility without real-name verification', () => {
  const sessionWith = (agreementResponse: Partial<HttpResponse> | undefined) => {
    const { http } = fakeHttp(({ url }) => {
      if (url.endsWith('/jwToken/check')) return tokenCheck(false);
      if (url.endsWith('/authrouter/unrealname/agreement')) return agreementResponse;
      return undefined;
    });
    return createHarmonyOsSession({
      config: staticConfig({}),
      http,
      tokenStore: memoryStore({ jwtToken: JWT, siteId: '7' }),
    });
  };

  it('allows signing once the current agreement is accepted', async () => {
    await expect(sessionWith(agreement(true, true)).resolveAgcAuth()).resolves.toEqual({
      uid: 'u1',
      teamId: 'u1',
      accessToken: 'at',
      baseUrl: HUAWEI_SITES.EU.agcBaseUrl,
    });
  });

  it('refuses when the current agreement has not been accepted', async () => {
    for (const [signed, latest] of [
      [false, false],
      [true, false],
    ]) {
      await expect(sessionWith(agreement(signed!, latest!)).resolveAgcAuth()).rejects.toThrow(
        /has not accepted the current HUAWEI Developer Basic Service Agreement/,
      );
    }
  });

  it('defers to AGC when the agreement status cannot be read', async () => {
    await expect(sessionWith({ statusCode: 500 }).resolveAgcAuth()).resolves.toMatchObject({ teamId: 'u1' });
  });
});

describe('HarmonyOS session login', () => {
  it('completes when the browser comes back before its launcher exits', async () => {
    // xdg-open without a desktop environment, or $BROWSER, returns only when the browser closes.
    vi.mocked(openBrowser).mockImplementationOnce(async (url) => {
      await callBack(url, 'tempToken=tmp&siteId=7');
      return new Promise<void>(() => {});
    });
    const store = memoryStore();
    const session = createHarmonyOsSession({ config: staticConfig({}), http: fakeHttp(euLogin).http, tokenStore: store });
    await expect(session.login({ timeoutMs: 5_000 })).resolves.toMatchObject({ siteCode: 'EU' });
    expect(store.load()).toEqual({ jwtToken: JWT, siteId: '7' });
  });

  it('carries on when no browser can be opened', async () => {
    vi.mocked(openBrowser).mockRejectedValueOnce(new Error('xdg-open: not found'));
    const warnings: string[] = [];
    let loginUrl = '';
    const session = createHarmonyOsSession({
      config: staticConfig({}),
      http: fakeHttp(euLogin).http,
      tokenStore: memoryStore(),
      logger: { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} },
      onLoginUrl: (u) => {
        loginUrl = u;
      },
    });
    const pending = session.login({ timeoutMs: 5_000 });
    await vi.waitFor(() => expect(loginUrl).not.toBe(''));
    await callBack(loginUrl, 'tempToken=tmp&siteId=7');
    await expect(pending).resolves.toMatchObject({ userId: 'u1' });
    expect(warnings).toEqual([expect.stringMatching(/Could not open a browser automatically: xdg-open: not found/)]);
  });

  it('refuses an account from a region it does not know, storing nothing', async () => {
    const { http, calls } = fakeHttp(euLogin);
    const store = memoryStore();
    let loginUrl = '';
    const session = createHarmonyOsSession({
      config: staticConfig({}),
      http,
      tokenStore: store,
      onLoginUrl: (u) => {
        loginUrl = u;
      },
    });
    const settled = expect(session.login({ timeoutMs: 5_000 })).rejects.toThrow(/does not know \(siteId 42\)/);
    await vi.waitFor(() => expect(loginUrl).not.toBe(''));
    await callBack(loginUrl, 'tempToken=tmp&siteId=42');
    await settled;
    expect(calls).toEqual([]);
    expect(store.load()).toBeNull();
  });

  it('asks the sign-in page for this client, on the loopback port it listens on', async () => {
    let loginUrl = '';
    const session = createHarmonyOsSession({
      config: staticConfig({}),
      http: fakeHttp(euLogin).http,
      tokenStore: memoryStore(),
      onLoginUrl: (u) => {
        loginUrl = u;
      },
    });
    const settled = expect(session.login({ timeoutMs: 5_000 })).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(loginUrl).not.toBe(''));
    const url = new URL(loginUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${HUAWEI_SITES.CN.loginUrl}/console/DevEcoIDE/apply`);
    expect(url.searchParams.get('appid')).toBe('1009');
    expect(url.searchParams.get('code')).toMatch(/^[0-9a-f]{32}$/);
    expect(openBrowser).toHaveBeenLastCalledWith(loginUrl);
    await callBack(loginUrl, 'quit=true');
    await settled;
  });
});

describe('HarmonyOS session login, browser elsewhere', () => {
  /** A session that reports its sign-in URL; `url()` resolves once it is known. */
  function watched(logger?: Logger) {
    let resolveUrl!: (u: string) => void;
    const url = new Promise<string>((r) => (resolveUrl = r));
    const ports: number[] = [];
    const store = memoryStore();
    const { http, calls } = fakeHttp(euLogin);
    const session = createHarmonyOsSession({
      config: staticConfig({}),
      http,
      tokenStore: store,
      logger,
      onLoginUrl: (u, { port }) => {
        ports.push(port);
        resolveUrl(u);
      },
    });
    return { session, url: () => url, ports, store, calls };
  }

  it('completes from a pasted callback address, after reporting one that is not it', async () => {
    vi.mocked(openBrowser).mockClear();
    const warnings: string[] = [];
    const w = watched({ debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} });
    async function* pasted() {
      const { searchParams } = new URL(await w.url());
      yield '';
      yield 'https://example.com/not-it';
      // As copied from the address bar of a browser on another machine.
      yield `http://127.0.0.1:${searchParams.get('port')}/callback?code=${searchParams.get('code')}&tempToken=tmp&siteId=7`;
      // Never read: the sign-in is already complete.
      throw new Error('read past the callback');
    }
    await expect(w.session.login({ timeoutMs: 5_000, openBrowser: false, pastedCallbacks: pasted() })).resolves.toMatchObject({
      siteCode: 'EU',
    });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(w.store.load()).toEqual({ jwtToken: JWT, siteId: '7' });
    expect(warnings).toEqual([expect.stringMatching(/not this sign-in's callback: it has no `code` parameter/)]);
    // The pasted temp token is what was redeemed, on the account's own region.
    expect(w.calls[0]!.url).toBe(`${HUAWEI_SITES.EU.loginUrl}/authrouter/auth/api/temptoken/check`);
    expect(w.calls[0]!.opts?.query).toMatchObject({ tempToken: 'tmp', site: 'DE' });
  });

  it('listens on a fixed port, still completing through it while waiting for a paste', async () => {
    const probe = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as net.AddressInfo;
        s.close(() => resolve(port));
      });
    });
    const w = watched();
    // stdin that never yields anything, like an idle terminal.
    const idle: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    const pending = w.session.login({ timeoutMs: 5_000, port: probe, openBrowser: false, pastedCallbacks: idle });
    const url = new URL(await w.url());
    expect(url.searchParams.get('port')).toBe(String(probe));
    expect(w.ports).toEqual([probe]);
    // What the far end of `ssh -L <port>:127.0.0.1:<port>` delivers.
    await callBack(url.href, 'tempToken=tmp&siteId=7');
    await expect(pending).resolves.toMatchObject({ userId: 'u1' });
  });

  it('times out when nothing comes back, having sent nothing anywhere', async () => {
    const w = watched();
    await expect(
      w.session.login({ timeoutMs: 200, openBrowser: false, pastedCallbacks: (async function* () {})() }),
    ).rejects.toThrow(/Timed out/);
    expect(w.calls).toEqual([]);
  });
});

describe('HarmonyOS session state', () => {
  it('validates the stored JWT with its region, minting an access token on refresh', async () => {
    const { http, calls } = fakeHttp(({ url }) => (url.endsWith('/jwToken/check') ? tokenCheck(true) : undefined));
    const session = createHarmonyOsSession({ config: staticConfig({}), http, tokenStore: memoryStore({ jwtToken: JWT, siteId: '1' }) });
    await expect(session.getUserInfo({ refresh: true })).resolves.toEqual({
      userId: 'u1',
      userName: 'n',
      accessToken: 'at',
      countryCode: 'IT',
      siteCode: 'CN',
      isRealName: true,
    });
    expect(calls[0]!.url).toBe(`${HUAWEI_SITES.CN.loginUrl}/authrouter/auth/api/jwToken/check`);
    expect(calls[0]!.opts?.headers).toEqual({ refresh: 'true', jwtToken: JWT });
  });

  it('forgets a session the server no longer accepts', async () => {
    const { http } = fakeHttp(() => ({ data: JSON.stringify({ status: false }) }));
    const store = memoryStore({ jwtToken: JWT, siteId: '7' });
    const session = createHarmonyOsSession({ config: staticConfig({}), http, tokenStore: store });
    await expect(session.getUserInfo()).resolves.toBeNull();
    expect(store.load()).toBeNull();
    await expect(session.resolveAgcAuth()).rejects.toThrow(/Not signed in/);
  });

  it('forgets a session from an unknown region without calling anyone', async () => {
    const { http, calls } = fakeHttp(() => tokenCheck(true));
    const store = memoryStore({ jwtToken: JWT, siteId: '42' });
    await expect(createHarmonyOsSession({ config: staticConfig({}), http, tokenStore: store }).getUserInfo()).resolves.toBeNull();
    expect(calls).toEqual([]);
    expect(store.load()).toBeNull();
  });

  it('keeps the session when validation itself fails, and says so', async () => {
    const { http } = fakeHttp(() => ({ statusCode: 502, data: 'Bad Gateway' }));
    const store = memoryStore({ jwtToken: JWT, siteId: '7' });
    const session = createHarmonyOsSession({ config: staticConfig({}), http, tokenStore: store });
    await expect(session.getUserInfo()).rejects.toThrow(/Could not validate the session with .*\(HTTP 502: Bad Gateway\)/);
    expect(store.load()).not.toBeNull();
  });

  it('logs out with the region, and clears locally even when the server is unreachable', async () => {
    for (const reachable of [true, false]) {
      const { http, calls } = fakeHttp(() => (reachable ? { data: '' } : { throws: true }));
      const store = memoryStore({ jwtToken: JWT, siteId: '7' });
      const session = createHarmonyOsSession({ config: staticConfig({}), http, tokenStore: store });
      await expect(session.logout()).resolves.toBe(true);
      expect(calls.map((c) => c.url)).toEqual([`${HUAWEI_SITES.EU.loginUrl}/authrouter/auth/api/logout`]);
      expect(store.load()).toBeNull();
    }
  });

  it('has nothing to log out of when signed out', async () => {
    const { http, calls } = fakeHttp(() => undefined);
    await expect(createHarmonyOsSession({ config: staticConfig({}), http, tokenStore: memoryStore() }).logout()).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('explains team-list failures', async () => {
    const withTeams = (teams: Partial<HttpResponse>) =>
      createHarmonyOsSession({
        config: staticConfig({}),
        http: fakeHttp(({ url }) => (url.endsWith('/jwToken/check') ? tokenCheck(true) : teams)).http,
        tokenStore: memoryStore({ jwtToken: JWT, siteId: '1' }),
      });
    await expect(withTeams({ statusCode: 401 }).listTeams()).rejects.toThrow(/session has expired/);
    await expect(withTeams({ statusCode: 500, data: 'boom' }).listTeams()).rejects.toThrow(/Could not list AGC teams \(HTTP 500: boom\)/);
    await expect(withTeams({ data: JSON.stringify({ ret: { code: 0 }, teams: [{ id: 't', name: 'T' }] }) }).listTeams()).resolves.toEqual([
      { id: 't', name: 'T' },
    ]);
  });

  it('reports the developer agreement, or null when it cannot be read', async () => {
    const withAgreement = (response: Partial<HttpResponse>) =>
      createHarmonyOsSession({
        config: staticConfig({}),
        http: fakeHttp(() => response).http,
        tokenStore: memoryStore(),
      });
    const user = { userId: 'u1', userName: 'n', accessToken: 'at', countryCode: 'IT', siteCode: 'EU' as const, isRealName: false };
    await expect(withAgreement(agreement(true, false)).getDeveloperAgreement(user)).resolves.toEqual({ signed: true, latest: false });
    await expect(withAgreement({ data: 'not json' }).getDeveloperAgreement(user)).resolves.toBeNull();
    await expect(withAgreement({ data: JSON.stringify({ success: false }) }).getDeveloperAgreement(user)).resolves.toBeNull();
  });

  it('signs under another team when asked', async () => {
    const { http } = fakeHttp(({ url }) => (url.endsWith('/jwToken/check') ? tokenCheck(true) : undefined));
    const session = createHarmonyOsSession({ config: staticConfig({}), http, tokenStore: memoryStore({ jwtToken: JWT, siteId: '1' }) });
    await expect(session.resolveAgcAuth({ teamId: 'team-9' })).resolves.toMatchObject({ uid: 'u1', teamId: 'team-9' });
  });
});
