import StreamZip from 'node-stream-zip';

// node-stream-zip's types are thin; this is the minimal shape we use (mirrors diffHapAssets.ts).
interface ZipEntry {
  name: string;
  isDirectory: boolean;
}
interface StreamZipAsync {
  entries(): Promise<Record<string, ZipEntry>>;
  entryData(entry: ZipEntry): Promise<Buffer>;
  close(): Promise<void>;
}

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
  const zip = new (StreamZip as unknown as { async: new (cfg: { file: string }) => StreamZipAsync }).async({ file: hapPath });
  try {
    const entries = await zip.entries();
    const entry = entries['module.json'] ?? entries['config.json'];
    return entry ? bundleNameFromHapConfig((await zip.entryData(entry)).toString('utf8')) : null;
  } finally {
    await zip.close();
  }
}
