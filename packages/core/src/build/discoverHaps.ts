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

/**
 * The build module a HAP belongs to, parsed from its filename
 * (`<module>-<target>-<buildMode>-{signed,unsigned}.hap`): the segment before
 * the first dash. This is the build module NAME — what `--module` refers to and
 * what hvigor stamps into the filename — which, unlike the first path segment,
 * is robust to nested project layouts (e.g. systemui's
 * `product/phone/<folder>/build/.../phone_gestureNavigation-...-signed.hap`,
 * where the module folder is not a top-level directory under projectDir).
 */
function moduleOfHap(hapFileName: string): string {
  const dash = hapFileName.indexOf('-');
  return dash > 0 ? hapFileName.slice(0, dash) : hapFileName.replace(/\.hap$/i, '');
}

/**
 * Walk a project's build outputs and group `*-signed.hap` / `*-unsigned.hap`
 * by build module name (parsed from the HAP filename). Skips `node_modules` /
 * `oh_modules` / `.git`. Ported from the proven MCP `findHaps`, extended with
 * per-module grouping so multi-module projects can install the right HAP.
 * Empty object when nothing is built.
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
        const moduleName = moduleOfHap(e.name);
        const bucket = (result[moduleName] ??= { signed: [], unsigned: [] });
        if (e.name.includes('unsigned')) bucket.unsigned.push(full);
        else if (e.name.includes('signed')) bucket.signed.push(full);
      }
    }
  };

  await walk(projectDir, 0);
  return result;
}
