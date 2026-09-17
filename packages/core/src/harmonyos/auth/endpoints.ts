/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/auth/auth-config.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 *
 * These are private, undocumented Huawei endpoints and can change without notice.
 */

/** Client ID the DevEco CLI registers as with the Huawei login service. */
export const HUAWEI_APP_ID = '1009';

/** Version string the temp-token exchange expects. */
export const HUAWEI_API_VERSION = '1.0.0';

/** How long to wait for the user to finish signing in in their browser. */
export const LOGIN_TIMEOUT_MS = 600_000;

export type HuaweiSiteCode = 'CN' | 'EU' | 'SG' | 'RU';

export interface HuaweiSite {
  code: HuaweiSiteCode;
  /** `siteId` as reported by the login callback. */
  siteId: string;
  /** The token exchange's `site` parameter. The European site's is `DE`, not `EU`. */
  siteParam: string;
  /** Sign-in page and `authrouter` token endpoints. */
  loginUrl: string;
  /** AppGallery Connect certificate, device and profile calls. */
  agcBaseUrl: string;
  language: string;
}

/**
 * Regional endpoints.
 *
 * Upstream hardcodes the Chinese-mainland hosts and refuses any other `siteId`.
 * DevEco Studio resolves every host through Huawei's Global Routing Service (GRS),
 * service `com.huawei.devecostudio.region`, by the user's country; these are its
 * answers for keys `spaceintroduce` (sign-in, token exchange) and `agcsign`
 * (signing). If a region stops working, diff against
 *
 *   POST https://grs.dbankcloud.com/grs/2.0/router?issue_country=<ISO>&app_name=devecostudio
 *
 * The `siteId` → `site` mapping is DevEco Studio's own (1 CN, 5 SG, 7 DE, 8 RU).
 */
export const HUAWEI_SITES: Readonly<Record<HuaweiSiteCode, HuaweiSite>> = {
  CN: {
    code: 'CN',
    siteId: '1',
    siteParam: 'CN',
    loginUrl: 'https://cn.devecostudio.huawei.com',
    agcBaseUrl: 'https://connect-api.cloud.huawei.com',
    language: 'zh_CN',
  },
  SG: {
    code: 'SG',
    siteId: '5',
    siteParam: 'SG',
    loginUrl: 'https://sg.devecostudio.huawei.com',
    agcBaseUrl: 'https://connect-api-dra.cloud.huawei.com',
    language: 'zh_CN',
  },
  EU: {
    code: 'EU',
    siteId: '7',
    siteParam: 'DE',
    loginUrl: 'https://de.devecostudio.huawei.com',
    agcBaseUrl: 'https://connect-api-dre.cloud.huawei.com',
    language: 'de_DE',
  },
  RU: {
    code: 'RU',
    siteId: '8',
    siteParam: 'RU',
    loginUrl: 'https://ru.devecostudio.huawei.com',
    agcBaseUrl: 'https://connect-api-drru.cloud.huawei.com',
    language: 'ru_RU',
  },
};

/** The team list is served from one host for every region (GRS key `agcups`). */
export const AGC_TEAMS_URL = 'https://connect-api.cloud.huawei.com/api/ups/user-permission-service/v1/user-team-list';

/**
 * Resolve the `siteId` the login callback reports, or null for one this table does
 * not know — sending an account's token to another region's hosts gets it refused.
 */
export function siteForId(siteId: string): HuaweiSite | null {
  return Object.values(HUAWEI_SITES).find((s) => s.siteId === siteId) ?? null;
}

/** Paths shared by every region; only the host differs. */
export const AUTH_PATHS = {
  /** The browser authenticates here, then redirects to the loopback server. */
  AUTH_APPLY: 'console/DevEcoIDE/apply',
  /** Exchanges the browser's temp token for a JWT. */
  TEMP_TOKEN_CHECK: 'authrouter/auth/api/temptoken/check',
  /** Validates a JWT and, with `refresh`, mints an AGC access token. */
  JWT_TOKEN_CHECK: 'authrouter/auth/api/jwToken/check',
  LOGIN_SUCCESS: 'console/DevEcoCLI/loginSuccess',
  LOGIN_FAILED: 'console/DevEcoCLI/loginFailed',
  LOGOUT: 'authrouter/auth/api/logout',
  /**
   * Whether an account without real-name verification accepted the developer
   * agreement, which is what lets it sign. From DevEco Studio (`space.agr.url`).
   */
  UNREALNAME_AGREEMENT: 'authrouter/unrealname/agreement',
} as const;
