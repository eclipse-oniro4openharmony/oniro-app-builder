import StreamZip from 'node-stream-zip';

// node-stream-zip's types are thin; this is the minimal shape we use (mirrors sdk/extract.ts).
interface ZipEntry {
  name: string;
  isDirectory: boolean;
}
interface StreamZipAsync {
  entries(): Promise<Record<string, ZipEntry>>;
  close(): Promise<void>;
}

export interface HapAssetDiff {
  /** File paths present in the new HAP but not the installed one. */
  addedAssetPaths: string[];
  /** File paths present in the installed HAP but not the new one. */
  removedAssetPaths: string[];
}

/** Pure set-diff of two file-name listings, sorted. */
export function diffEntryNames(installed: Iterable<string>, next: Iterable<string>): HapAssetDiff {
  const installedSet = new Set(installed);
  const nextSet = new Set(next);
  return {
    addedAssetPaths: [...nextSet].filter((n) => !installedSet.has(n)).sort(),
    removedAssetPaths: [...installedSet].filter((n) => !nextSet.has(n)).sort(),
  };
}

async function listFileEntries(hapPath: string): Promise<string[]> {
  const zip = new (StreamZip as unknown as { async: new (cfg: { file: string }) => StreamZipAsync }).async({ file: hapPath });
  try {
    const entries = await zip.entries();
    return Object.values(entries)
      .filter((e) => !e.isDirectory)
      .map((e) => e.name);
  } finally {
    await zip.close();
  }
}

/**
 * Diff the file manifests of two HAP (zip) archives. Drives the ACE-extractor
 * cache-invalidation reboot decision in `applyChanges`: when the new HAP adds or
 * renames file paths vs the installed one, the path-keyed asset cache can serve
 * stale "GetAsset failed" errors until a reboot.
 */
export async function diffHapAssets(opts: { installedHap: string; newHap: string }): Promise<HapAssetDiff> {
  const [installed, next] = await Promise.all([listFileEntries(opts.installedHap), listFileEntries(opts.newHap)]);
  return diffEntryNames(installed, next);
}
