import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { getOhosBaseSdkHome } from '../sdk/paths.js';
import { generateSigningConfigs, type Apl, type AppFeature, type SigningPasswords } from '../sign/generateSigningConfigs.js';
import { readJson5File } from './jsonHelpers.js';

export interface PrepareSigningOptions {
  config: ConfigProvider;
  projectDir: string;
  // Forwarded to the fresh-generate fallback:
  apl?: Apl;
  appFeature?: AppFeature;
  acls?: string[];
  passwords?: SigningPasswords;
  logger?: Logger;
}

export interface PrepareSigningResult {
  source: 'present' | 'fresh';
}

/** A project has usable signing material if `signatures/` exists AND build-profile declares signingConfigs. */
function hasSigningArtifacts(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, 'signatures'))) return false;
  const buildProfile = path.join(dir, 'build-profile.json5');
  if (!fs.existsSync(buildProfile)) return false;
  try {
    const parsed = readJson5File<{ app?: { signingConfigs?: unknown[] } }>(buildProfile);
    return Array.isArray(parsed.app?.signingConfigs) && parsed.app!.signingConfigs!.length > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure a project has signing material: a no-op when `signatures/` +
 * signingConfigs already exist ('present'), otherwise generate them via
 * {@link generateSigningConfigs} ('fresh', which needs java + the SDK).
 */
export function prepareSigning(opts: PrepareSigningOptions): PrepareSigningResult {
  if (hasSigningArtifacts(opts.projectDir)) {
    return { source: 'present' };
  }
  generateSigningConfigs({
    projectDir: opts.projectDir,
    sdkHome: getOhosBaseSdkHome(opts.config),
    apl: opts.apl,
    appFeature: opts.appFeature,
    acls: opts.acls,
    passwords: opts.passwords,
    logger: opts.logger,
  });
  return { source: 'fresh' };
}
