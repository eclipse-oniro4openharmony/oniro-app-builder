import { readZipEntry } from '../sdk/extract.js';

/** `app.bundleName` from the text of a HAP's `module.json` (stage model) or `config.json` (FA model), or null. */
export function bundleNameFromHapConfig(text: string): string | null {
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, '')) as { app?: { bundleName?: unknown } };
    const name = parsed.app?.bundleName;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/** The bundle a HAP installs as, read from its `module.json` or `config.json`; null when neither names one. */
export async function readHapBundleName(hapPath: string): Promise<string | null> {
  const config =
    (await readZipEntry(hapPath, (n) => n === 'module.json')) ??
    (await readZipEntry(hapPath, (n) => n === 'config.json'));
  return config ? bundleNameFromHapConfig(config.toString('utf8')) : null;
}
