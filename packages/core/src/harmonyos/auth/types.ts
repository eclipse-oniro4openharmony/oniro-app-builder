/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/auth/types/auth-types.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import type { HuaweiSiteCode } from './endpoints.js';

/** A signed-in Huawei developer account. */
export interface HuaweiUserInfo {
  userId: string;
  userName: string;
  /** AGC OAuth2 token. Short-lived — minted from the stored JWT on demand. */
  accessToken: string;
  countryCode: string;
  /** Region the account is registered on — decides which hosts to talk to. */
  siteCode: HuaweiSiteCode;
  /**
   * Whether the account completed real-name verification. Accounts that did not
   * can still sign once they accept the developer agreement.
   */
  isRealName: boolean;
}

/** Acceptance state of the HUAWEI Developer Basic Service Agreement. */
export interface DeveloperAgreementStatus {
  /** Some version has been accepted. */
  signed: boolean;
  /** The current version has been accepted. */
  latest: boolean;
}

/** An AGC team the signed-in user belongs to. Certificates are issued per team. */
export interface HuaweiTeam {
  id: string;
  name: string;
}

/** What an AGC call needs: who, which team, a fresh access token, and the regional host. */
export interface AgcAuthInfo {
  uid: string;
  teamId: string;
  accessToken: string;
  /** Regional AGC signing host, e.g. `https://connect-api-dre.cloud.huawei.com`. */
  baseUrl: string;
}
