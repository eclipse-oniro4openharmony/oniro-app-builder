import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import type { RuntimeOs } from '../harmonyos/target.js';

interface Profile {
  app?: {
    products?: Array<{ name?: unknown; signingConfig?: unknown }>;
    signingConfigs?: Array<{ name?: unknown; type?: unknown }>;
  };
}

/**
 * Why the signingConfig a product names cannot sign for the runtime it targets,
 * or undefined when it can (or names none, or the profile cannot be read).
 *
 * A HarmonyOS device accepts only AppGallery Connect material, which
 * `sign --harmonyos` writes with `type: "HarmonyOS"`, the field hvigor keys on.
 * Material without it is the OpenHarmony development certificate a plain `sign`
 * writes, and hvigor's SignHap still signs with it, producing a
 * `-signed.hap` that only fails at install time (#19). The mirror case, HarmonyOS
 * material on an OpenHarmony product, is reported too. Reads the named product,
 * else the first one, like {@link detectRuntimeOs}.
 */
export function signingMismatch(projectDir: string, runtimeOS: RuntimeOs, productName?: string): string | undefined {
  let profile: Profile;
  try {
    profile = JSON5.parse(fs.readFileSync(path.join(projectDir, 'build-profile.json5'), 'utf-8')) as Profile;
  } catch {
    return undefined;
  }
  const products = Array.isArray(profile.app?.products) ? profile.app.products : [];
  const product = products.find((p) => p.name === productName) ?? products[0];
  const configName = product?.signingConfig;
  if (typeof configName !== 'string' || !configName) return undefined;
  const configs = Array.isArray(profile.app?.signingConfigs) ? profile.app.signingConfigs : [];
  const config = configs.find((c) => c.name === configName);
  if (!config) return undefined;

  const productLabel = typeof product?.name === 'string' ? `Product '${product.name}'` : 'The product';
  const harmonyOsMaterial = config.type === 'HarmonyOS';
  if (runtimeOS === 'HarmonyOS' && !harmonyOsMaterial) {
    return (
      `${productLabel} targets HarmonyOS, but its signingConfig '${configName}' holds OpenHarmony material ` +
      '(no `type: "HarmonyOS"`), so the signed HAP will not install on a HarmonyOS device. Run ' +
      '`oniro-app sign --harmonyos` to have AppGallery Connect issue a certificate and profile, then build again.'
    );
  }
  if (runtimeOS === 'OpenHarmony' && harmonyOsMaterial) {
    return (
      `${productLabel} targets OpenHarmony, but its signingConfig '${configName}' holds HarmonyOS (AppGallery ` +
      'Connect) material, which an OpenHarmony device will not accept. Run `oniro-app sign` for OpenHarmony ' +
      'material, or set runtimeOS "HarmonyOS" on the product if the app is meant for HarmonyOS.'
    );
  }
  return undefined;
}
