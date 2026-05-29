import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ModuleHaps {
  signed: string[];
  unsigned: string[];
}

export interface DiscoverHapsOptions {
  projectDir: string;
  /** Max directory recursion depth. Default 8. */
  maxDepth?: number;
}

/** The module folder a built HAP belongs to (first path segment under projectDir). */
function moduleOf(projectDir: string, hapPath: string): string {
  const rel = path.relative(projectDir, hapPath);
  const first = rel.split(path.sep)[0];
  return first && first !== '..' ? first : '(root)';
}

/**
 * Walk a project's build outputs and group `*-signed.hap` / `*-unsigned.hap`
 * by module folder. Skips `node_modules` / `oh_modules` / `.git`. Ported from
 * the proven MCP `findHaps`, extended with per-module grouping so multi-module
 * projects can install the right HAP. Empty object when nothing is built.
 */
export async function discoverHaps(opts: DiscoverHapsOptions): Promise<Record<string, ModuleHaps>> {
  const { projectDir } = opts;
  const maxDepth = opts.maxDepth ?? 8;
  const result: Record<string, ModuleHaps> = {};

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'oh_modules' || e.name === '.git') continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.hap')) {
        const moduleName = moduleOf(projectDir, full);
        const bucket = (result[moduleName] ??= { signed: [], unsigned: [] });
        if (e.name.includes('unsigned')) bucket.unsigned.push(full);
        else if (e.name.includes('signed')) bucket.signed.push(full);
      }
    }
  };

  await walk(projectDir, 0);
  return result;
}
