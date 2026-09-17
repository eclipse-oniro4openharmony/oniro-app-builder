/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/auth/login/login-service.ts`, `src/auth/utils/token-checker.ts`,
 * `src/auth/login/user-info-fetcher.ts`, `src/auth/team/team-service.ts`),
 * Copyright (c) 2026 Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/harmonyos/NOTICE.md.
 */
import * as crypto from 'node:crypto';
import type { ConfigProvider } from '../../ports/config.js';
import type { Logger } from '../../ports/logger.js';
import { noopLogger } from '../../ports/logger.js';
import { OniroError } from '../../ports/errors.js';
import { createHttpClient, describeResponse, type HarmonyOsHttpClient } from '../http.js';
import { createTokenStore, type TokenStore } from './tokenStore.js';
import {
  AGC_TEAMS_URL,
  AUTH_PATHS,
  HUAWEI_APP_ID,
  HUAWEI_API_VERSION,
  HUAWEI_SITES,
  LOGIN_TIMEOUT_MS,
  siteForId,
  type HuaweiSite,
} from './endpoints.js';
import { startCallbackServer } from './callbackServer.js';
import { openBrowser } from './browser.js';
import type { AgcAuthInfo, DeveloperAgreementStatus, HuaweiTeam, HuaweiUserInfo } from './types.js';

export interface HarmonyOsSessionOptions {
  config: ConfigProvider;
  logger?: Logger;
  http?: HarmonyOsHttpClient;
  tokenStore?: TokenStore;
  /** Called with the sign-in URL before the browser opens, so a CLI can print it. */
  onLoginUrl?: (url: string) => void;
}

export interface HarmonyOsSession {
  login(opts?: { timeoutMs?: number }): Promise<HuaweiUserInfo>;
  /** Resolves false when there was no session to end. */
  logout(): Promise<boolean>;
  /** The signed-in account, or null. `refresh` mints a fresh AGC access token. */
  getUserInfo(opts?: { refresh?: boolean }): Promise<HuaweiUserInfo | null>;
  listTeams(): Promise<HuaweiTeam[]>;
  /** Credentials for AGC calls. Throws when signed out, or when the account may not sign. */
  resolveAgcAuth(opts?: { teamId?: string }): Promise<AgcAuthInfo>;
  /** Whether the account accepted the developer agreement; null when undeterminable. */
  getDeveloperAgreement(user: HuaweiUserInfo): Promise<DeveloperAgreementStatus | null>;
  readonly tokenPath: string;
}

/** Response of `jwToken/check`. */
interface TokenCheckResponse {
  status?: boolean;
  userInfo?: { accessToken?: string; userId?: string; name?: string; nationalCode?: string; realName?: unknown };
}

const NOT_SIGNED_IN = 'Not signed in. Run `oniro-app auth login` first.';

export function createHarmonyOsSession(opts: HarmonyOsSessionOptions): HarmonyOsSession {
  const logger = opts.logger ?? noopLogger;
  const http = opts.http ?? createHttpClient({ logger });
  const store = opts.tokenStore ?? createTokenStore({ config: opts.config, logger });

  /** Exchange the browser's short-lived temp token for the durable JWT. */
  async function exchangeTempToken(site: HuaweiSite, tempToken: string): Promise<string> {
    const response = await http.get(`${site.loginUrl}/${AUTH_PATHS.TEMP_TOKEN_CHECK}`, {
      query: {
        // The page sometimes appends extra `&`-joined parameters to the token.
        tempToken: tempToken.split('&')[0],
        site: site.siteParam,
        version: HUAWEI_API_VERSION,
        appid: HUAWEI_APP_ID,
      },
    });
    const jwtToken = response.data.trim();
    if (response.statusCode === 200 && /^[^.]+\.[^.]+\.[^.]+$/.test(jwtToken)) return jwtToken;

    // Any token the endpoint will not redeem — expired, reused, or sent to the
    // wrong region — gets the same empty 200, so there is no reason to report.
    throw new OniroError(
      `${site.loginUrl} would not exchange the login token for a session (${describeResponse(response)}). ` +
        'Login tokens are single-use and short-lived; run `oniro-app auth login` again.',
    );
  }

  /** Validate the JWT with its region; null when it is no longer valid. */
  async function userFromJwt(site: HuaweiSite, jwtToken: string, refresh: boolean): Promise<HuaweiUserInfo | null> {
    const response = await http.get(`${site.loginUrl}/${AUTH_PATHS.JWT_TOKEN_CHECK}`, {
      headers: { refresh: String(refresh), jwtToken },
    });
    let info: TokenCheckResponse;
    try {
      if (response.statusCode !== 200) throw new Error();
      info = JSON.parse(response.data) as TokenCheckResponse;
    } catch {
      throw new OniroError(`Could not validate the session with ${site.loginUrl} (${describeResponse(response)}).`);
    }
    const user = info.userInfo;
    if (!info.status || !user?.accessToken) return null;
    return {
      userId: user.userId ?? '',
      userName: user.name ?? '',
      accessToken: user.accessToken,
      countryCode: user.nationalCode ?? '',
      siteCode: site.code,
      isRealName: String(user.realName) === 'true',
    };
  }

  async function getUserInfo(o: { refresh?: boolean } = {}): Promise<HuaweiUserInfo | null> {
    const stored = store.load();
    const site = stored && siteForId(stored.siteId);
    const user = site ? await userFromJwt(site, stored.jwtToken, o.refresh ?? false) : null;
    if (stored && !user) {
      logger.debug('[harmonyos] The stored session is no longer valid; clearing it.');
      store.clear();
    }
    return user;
  }

  async function requireUser(): Promise<HuaweiUserInfo> {
    const user = await getUserInfo({ refresh: true });
    if (!user) throw new OniroError(NOT_SIGNED_IN);
    return user;
  }

  async function getDeveloperAgreement(user: HuaweiUserInfo): Promise<DeveloperAgreementStatus | null> {
    try {
      const response = await http.get(`${HUAWEI_SITES[user.siteCode].loginUrl}/${AUTH_PATHS.UNREALNAME_AGREEMENT}`, {
        headers: { accessToken: user.accessToken },
      });
      const payload = JSON.parse(response.data) as {
        success?: unknown;
        body?: { signedFlag?: unknown; signLastestFlag?: unknown };
      };
      if (response.statusCode !== 200 || String(payload.success) !== 'true' || !payload.body) return null;
      return { signed: payload.body.signedFlag === true, latest: payload.body.signLastestFlag === true };
    } catch {
      return null;
    }
  }

  return {
    tokenPath: store.tokenPath,
    getUserInfo,
    getDeveloperAgreement,

    async login(o = {}): Promise<HuaweiUserInfo> {
      // Sign-in starts on the Chinese-mainland page, which redirects every account to
      // its own region's; the callback then reports which region that was.
      const start = HUAWEI_SITES.CN.loginUrl;
      const clientSecret = crypto.randomUUID().replace(/-/g, '');
      const server = await startCallbackServer({
        clientSecret,
        baseUrl: start,
        successPath: AUTH_PATHS.LOGIN_SUCCESS,
        failedPath: AUTH_PATHS.LOGIN_FAILED,
      });

      try {
        const loginUrl = `${start}/${AUTH_PATHS.AUTH_APPLY}?port=${server.port}&appid=${HUAWEI_APP_ID}&code=${clientSecret}`;
        opts.onLoginUrl?.(loginUrl);
        // Not awaited: some launchers exit only when the browser does.
        openBrowser(loginUrl).catch((err: Error) => {
          // Headless hosts have no browser; the URL was surfaced via onLoginUrl.
          logger.warn(`[harmonyos] Could not open a browser automatically: ${err.message}`);
        });

        const callback = await server.waitForCallback(o.timeoutMs ?? LOGIN_TIMEOUT_MS);
        const site = siteForId(callback.siteId);
        if (!site) {
          throw new OniroError(`The account belongs to a Huawei region oniro-app does not know (siteId ${callback.siteId}).`);
        }

        const jwtToken = await exchangeTempToken(site, callback.tempToken);
        const user = await userFromJwt(site, jwtToken, false);
        if (!user) throw new OniroError('Login did not yield a usable session. Try again.');
        store.save({ jwtToken, siteId: site.siteId });
        logger.info(`[harmonyos] Signed in as ${user.userName || user.userId} (${site.code}).`);
        return user;
      } finally {
        await server.stop();
      }
    },

    async logout(): Promise<boolean> {
      const stored = store.load();
      if (!stored) return false;
      const site = siteForId(stored.siteId);
      try {
        if (site) {
          await http.post(`${site.loginUrl}/${AUTH_PATHS.LOGOUT}`, {
            query: { jwtToken: stored.jwtToken },
            timeoutMs: 5_000,
          });
        }
      } catch {
        // Telling the server is best effort; clearing locally is what signs out here.
      } finally {
        store.clear();
      }
      return true;
    },

    async listTeams(): Promise<HuaweiTeam[]> {
      const user = await requireUser();
      const response = await http.get(AGC_TEAMS_URL, {
        headers: {
          oauth2Token: user.accessToken,
          uid: user.userId,
          source: 'cli',
          lang: HUAWEI_SITES[user.siteCode].language,
        },
        timeoutMs: 15_000,
      });
      if (response.statusCode === 401) {
        throw new OniroError('The session has expired. Run `oniro-app auth login` again.');
      }
      if (response.statusCode !== 200) {
        throw new OniroError(`Could not list AGC teams (${describeResponse(response)}).`);
      }
      return parseTeamList(response.data);
    },

    async resolveAgcAuth(o: { teamId?: string } = {}): Promise<AgcAuthInfo> {
      const user = await requireUser();
      // Real-name verification is not required: like DevEco Studio, an unverified
      // account — the norm outside the Chinese mainland — may sign once it has
      // accepted the developer agreement. Studio accepts it from a dialog; a CLI
      // must not accept legal terms silently, so it only checks.
      if (!user.isRealName) {
        const agreement = await getDeveloperAgreement(user);
        if (agreement && !(agreement.signed && agreement.latest)) {
          throw new OniroError(
            'This Huawei account has not accepted the current HUAWEI Developer Basic Service Agreement, which ' +
              'accounts without real-name verification need before AppGallery Connect issues signing material. ' +
              'Accept it in AppGallery Connect (https://developer.huawei.com/consumer/en/service/josp/agc/index.html) ' +
              'or by running automatic signing once in DevEco Studio, then try again.',
          );
        }
        // When the status cannot be read, AGC is the authority and refuses by itself.
      }
      return {
        uid: user.userId,
        // Personal accounts sign under their own user id; `--team-id` picks another team.
        teamId: o.teamId ?? user.userId,
        accessToken: user.accessToken,
        baseUrl: HUAWEI_SITES[user.siteCode].agcBaseUrl,
      };
    },
  };
}

/**
 * Parse the AGC team list. Failures arrive as HTTP 200 with a non-zero `ret.code`.
 *
 * @internal exposed for tests.
 */
export function parseTeamList(body: string): HuaweiTeam[] {
  let payload: { ret?: { code?: number; msg?: string }; teams?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  if (payload.ret && payload.ret.code !== 0) {
    throw new OniroError(
      `AppGallery Connect refused the team list (code ${payload.ret.code}${payload.ret.msg ? `: ${payload.ret.msg}` : ''}).`,
    );
  }
  if (!Array.isArray(payload.teams)) return [];
  return payload.teams
    .map((t: { id?: unknown; name?: unknown }) => ({ id: String(t?.id ?? ''), name: String(t?.name ?? '') }))
    .filter((t) => t.id);
}
