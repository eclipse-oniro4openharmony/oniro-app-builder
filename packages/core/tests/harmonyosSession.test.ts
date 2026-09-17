import { describe, expect, it, vi } from 'vitest';
import { createHarmonyOsSession } from '../src/harmonyos/auth/session.js';
import { HUAWEI_SITES } from '../src/harmonyos/auth/endpoints.js';
import type { StoredSession, TokenStore } from '../src/harmonyos/auth/tokenStore.js';
import type {
  HarmonyOsHttpClient,
  HttpRequestOptions,
  HttpResponse,
} from '../src/harmonyos/http.js';
import { staticConfig } from '../src/ports/config.js';

// Never launch a real browser from a test.
vi.mock('../src/harmonyos/auth/browser.js', () => ({ openBrowser: vi.fn(async () => {}) }));

const JWT = 'header.payload.signature';

interface Call {
  url: string;
  opts?: HttpRequestOptions;
}

type Route = (call: Call) => Partial<HttpResponse> | undefined;

/** HTTP client answering from `route`, recording every GET/POST. Unrouted calls get a 404. */
function fakeHttp(route: Route): { http: HarmonyOsHttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = async (url: string, opts?: HttpRequestOptions): Promise<HttpResponse> => {
    calls.push({ url, opts });
    const r = route({ url, opts }) ?? { statusCode: 404 };
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
