/**
 * SDK version formats, as hvigor reads them.
 *
 * Up to API 25 an OpenHarmony product declares its SDK as the API level (`20`) and a
 * HarmonyOS product as `"<release>(<api>)"` (`"6.1.1(24)"`). From API 26, hvigor 6.26
 * and later name every SDK by its dotted release instead (`"26.0.0"`, whose major is
 * the API level), for both runtimes:
 *
 * - `compileSdkVersion` / `compatibleSdkVersion` / `targetSdkVersion` are that string;
 *   hvigor rejects a number there, and misreads `"26.0.0(26)"`.
 * - An OpenHarmony product may declare a string only when `hvigor-config.json5`
 *   declares `modelVersion` 6.0.0 or later.
 * - The OpenHarmony SDK's components live under `<sdk home>/26.0.0/`, not
 *   `<sdk home>/26/` (see `sdk/apiDir.ts`).
 */

/** The first API level whose SDK is named by a dotted release (hvigor's `FIRST_DOT_API_VERSION`). */
export const FIRST_DOTTED_API = 26;

/** The hvigor-config `modelVersion` an OpenHarmony project needs to declare its SDK as a string. */
export const DOTTED_API_MODEL_VERSION = '6.0.0';

/** The hvigor release that first reads dotted SDK versions (it ships with the 26.0.0 command-line tools). */
export const DOTTED_API_MIN_HVIGOR = '6.26.0';

/** hvigor's pattern for a dotted SDK version (its `newDotSeparatedVersion`). */
const DOTTED_VERSION_RE = /^([2-9][0-9])\.[1-9]?[0-9]\.[1-9]?[0-9]$/;

/** Whether an SDK for `api` is named by a dotted release. */
export function usesDottedVersion(api: number | string): boolean {
  return Number(api) >= FIRST_DOTTED_API;
}

/** The API level a dotted SDK version names (`26.0.0` → 26), or undefined for anything else. */
export function apiOfDottedVersion(value: string): number | undefined {
  const m = DOTTED_VERSION_RE.exec(value.trim());
  if (!m) return undefined;
  const api = Number(m[1]);
  return usesDottedVersion(api) ? api : undefined;
}

/**
 * The dotted release naming the SDK for `api`: `platformVersion` (an installed SDK's
 * own) when it is one for that level, else `<api>.0.0`.
 */
export function dottedVersionFor(api: number, platformVersion?: string): string {
  return platformVersion !== undefined && apiOfDottedVersion(platformVersion) === api
    ? platformVersion.trim()
    : `${api}.0.0`;
}

/**
 * What an OpenHarmony product declares as its SDK: the API level up to 25, its
 * dotted release from 26 (see {@link dottedVersionFor}).
 */
export function ohosSdkVersionValue(api: number, platformVersion?: string): number | string {
  return usesDottedVersion(api) ? dottedVersionFor(api, platformVersion) : api;
}

/**
 * Compare dotted versions numerically (`6.24.2` < `6.26.0`); a missing or non-numeric
 * part counts as 0. Negative, zero or positive, like a sort comparator.
 */
export function compareDottedVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
