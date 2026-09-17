import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';

/**
 * Which runtime a project targets. OpenHarmony projects build against the public
 * OpenHarmony SDK; HarmonyOS projects build against Huawei's HarmonyOS SDK and
 * need an AGC-issued certificate to sign (see `harmonyos/signing`).
 */
export type RuntimeOs = 'OpenHarmony' | 'HarmonyOS';

/**
 * Detect the runtime a project targets from `build-profile.json5`.
 *
 * HarmonyOS only when the product declares `runtimeOS: "HarmonyOS"`, which DevEco
 * Studio writes for every HarmonyOS project. Anything else — no such field, or a
 * missing or unreadable profile — is OpenHarmony, so existing projects behave
 * exactly as they did before HarmonyOS support. Reads the named product, else the
 * first one.
 */
export function detectRuntimeOs(projectDir: string, productName?: string): RuntimeOs {
  let products: Array<{ name?: unknown; runtimeOS?: unknown }> = [];
  try {
    const parsed = JSON5.parse(fs.readFileSync(path.join(projectDir, 'build-profile.json5'), 'utf-8')) as {
      app?: { products?: unknown };
    };
    if (Array.isArray(parsed.app?.products)) products = parsed.app.products;
  } catch {
    return 'OpenHarmony';
  }
  const product = products.find((p) => p.name === productName) ?? products[0];
  return product?.runtimeOS === 'HarmonyOS' ? 'HarmonyOS' : 'OpenHarmony';
}

/**
 * HarmonyOS SDK releases, mapping API level to the release version DevEco writes
 * into `compileSdkVersion`, for when the installed SDK does not name the requested
 * level itself. Only releases read from a real `sdk/default/sdk-pkg.json` are listed.
 */
export const HARMONYOS_SDK_VERSIONS: ReadonlyMap<number, string> = new Map([
  [12, '5.0.0'],
  [13, '5.0.1'],
  [14, '5.0.2'],
  [15, '5.0.3'],
  [16, '5.0.4'],
  [17, '5.0.5'],
  [18, '5.1.0'],
  [19, '5.1.1'],
  [20, '6.0.0'],
  [21, '6.0.1'],
  [24, '6.1.1'],
]);

/**
 * The `"<version>(<api>)"` label a HarmonyOS product declares for an API level, or
 * undefined when no HarmonyOS release is known for it.
 */
export function harmonyOsSdkLabelForApi(api: number): string | undefined {
  const version = HARMONYOS_SDK_VERSIONS.get(api);
  return version ? `${version}(${api})` : undefined;
}
