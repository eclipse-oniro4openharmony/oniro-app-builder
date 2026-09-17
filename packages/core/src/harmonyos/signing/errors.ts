/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/config/signature.ts`, `src/signature/cert-api.ts`,
 * `src/signature/device-manager.ts`, `src/signature/generate-profile.ts`),
 * Copyright (c) 2026 Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/harmonyos/NOTICE.md.
 */
import { OniroError } from '../../ports/errors.js';

/** Raised when AppGallery Connect rejects a request, or its output does not check out. */
export class AgcError extends OniroError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retCode?: string,
  ) {
    super(message);
    this.name = 'AgcError';
  }
}

/** User-facing messages for the signing failure modes; each says what to do next. */
export const SIGNING_ERRORS = {
  FORBIDDEN:
    'This account has no AppGallery Connect permission for the selected team. Ask the team administrator for access, or pass --team-id for a team you do have access to (`oniro-app auth team list`).',
  UNAUTHORIZED: 'AppGallery Connect rejected the access token. Run `oniro-app auth login` again.',
  NETWORK:
    'Could not reach AppGallery Connect. Check the network connection and any proxy configuration (HTTPS_PROXY / HTTP_PROXY).',
  USER_NOT_HARMONY:
    'This Huawei account is not enrolled for HarmonyOS development. Request HarmonyOS access for it in AppGallery Connect.',
  CERT_REQUEST: 'AppGallery Connect did not issue the debug certificate.',
  CERT_LIMIT:
    'This team has reached its debug-certificate limit. Delete an unused certificate in AppGallery Connect and retry.',
  DEVICE_ADD: 'AppGallery Connect did not register the device.',
  DEVICE_LIMIT: 'This team has reached its device limit. Remove an unused device in AppGallery Connect and retry.',
  DEVICE_NAME_REPEAT: 'A device with that name is already registered. Retry.',
  DEVICE_NONE:
    'No device is connected and none is registered to this team, but a debug profile must name at least one. Connect a device and retry.',
  PROFILE_ADD: 'AppGallery Connect did not issue the provisioning profile.',
  PROFILE_NAME_REPEAT: 'A provisioning profile with that name already exists in AppGallery Connect. Retry.',
  PROVISION_LIMIT:
    'This team has reached its debug-profile limit. Delete unused profiles in AppGallery Connect and retry.',
  CERT_INVALID: 'AppGallery Connect returned an unreadable certificate. Retry with --force.',
  CERT_EXPIRED: 'The signing certificate is outside its validity window. Check the system clock, then retry with --force.',
  CERT_PROFILE_MISMATCH:
    'The provisioning profile was not issued for the downloaded certificate. Retry with --force.',
  KEYSTORE_CERT_MISMATCH:
    'The local keystore does not hold the key the downloaded certificate was issued for. Retry with --force.',
  BUNDLE_NAME_INVALID:
    'Invalid bundle name. It must be 7–128 characters, start with a letter, and have at least three dot-separated segments (for example com.example.app).',
} as const;

/** AGC `ret.code` values that have a specific remedy. */
const RET_CODE_ERRORS: Readonly<Record<string, string>> = {
  '205389872': SIGNING_ERRORS.CERT_LIMIT,
  '205389904': SIGNING_ERRORS.USER_NOT_HARMONY,
  '205389859': SIGNING_ERRORS.DEVICE_LIMIT,
  '205389857': SIGNING_ERRORS.DEVICE_NAME_REPEAT,
  '205389938': SIGNING_ERRORS.PROVISION_LIMIT,
  '205389830': SIGNING_ERRORS.PROFILE_NAME_REPEAT,
};

/** Reason phrase of the 403 Huawei's proxy answers with when it blocks the caller. */
const PROXY_BLOCKED = 'Openproxy_Blocked_URL_list';

/** The `ret` envelope around every AGC response. It is occasionally a JSON string itself. */
export function readRet(body: string): { code?: unknown; msg?: unknown } | null {
  try {
    let ret = (JSON.parse(body) as { ret?: unknown }).ret;
    if (typeof ret === 'string') ret = JSON.parse(ret);
    return ret && typeof ret === 'object' ? (ret as { code?: unknown; msg?: unknown }) : null;
  } catch {
    return null;
  }
}

export type AgcOperation = 'cert' | 'device' | 'profile';

const FALLBACK: Record<AgcOperation, string> = {
  cert: SIGNING_ERRORS.CERT_REQUEST,
  device: SIGNING_ERRORS.DEVICE_ADD,
  profile: SIGNING_ERRORS.PROFILE_ADD,
};

/**
 * Map an AGC failure onto an actionable error. AGC fails through the HTTP status,
 * the reason phrase, or a non-zero `ret.code` under HTTP 200; all three are read.
 */
export function mapAgcError(
  operation: AgcOperation,
  statusCode: number | undefined,
  reasonPhrase: string,
  body: string,
): AgcError {
  if (statusCode === 403) {
    return new AgcError(reasonPhrase === PROXY_BLOCKED ? SIGNING_ERRORS.NETWORK : SIGNING_ERRORS.FORBIDDEN, 403);
  }
  if (statusCode === 401) return new AgcError(SIGNING_ERRORS.UNAUTHORIZED, 401);

  const ret = readRet(body);
  const retCode = ret?.code === undefined ? undefined : String(ret.code);
  const msg = typeof ret?.msg === 'string' && ret.msg.trim() ? ret.msg : undefined;
  return new AgcError((retCode && RET_CODE_ERRORS[retCode]) || msg || FALLBACK[operation], statusCode, retCode);
}
