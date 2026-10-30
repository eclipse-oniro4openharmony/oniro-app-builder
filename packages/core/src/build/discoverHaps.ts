import * as fs from 'node:fs';
import * as path from 'node:path';
import { OniroError } from '../ports/errors.js';

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

/** A DevEco app project root: it holds `AppScope/app.json5` (a module folder does not). */
function isAppProjectRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'AppScope', 'app.json5'));
}

/**
 * Walk a project's build outputs and group `*-signed.hap` / `*-unsigned.hap`
 * by build module name (parsed from the HAP filename). Skips `node_modules` /
 * `oh_modules` / `.git`, and, when `projectDir` is an app project root, any
 * other app project nested inside it, whose HAPs belong to another app.
 * Ported from the proven MCP `findHaps`, extended with per-module grouping so
 * multi-module projects can install the right HAP. Each list is newest first,
 * so a fresh build wins over HAPs committed to the repository. Empty object
 * when nothing is built.
 */
export async function discoverHaps(opts: DiscoverHapsOptions): Promise<Record<string, ModuleHaps>> {
  const { projectDir } = opts;
  const maxDepth = opts.maxDepth ?? 8;
  const skipNestedProjects = isAppProjectRoot(projectDir);
  const result: Record<string, ModuleHaps> = {};

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'oh_modules' || e.name === '.git') continue;
        if (skipNestedProjects && isAppProjectRoot(full)) continue;
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
  const mtime = (p: string): number => fs.statSync(p).mtimeMs;
  for (const bucket of Object.values(result)) {
    bucket.signed.sort((a, b) => mtime(b) - mtime(a));
    bucket.unsigned.sort((a, b) => mtime(b) - mtime(a));
  }
  return result;
}

export interface PickedHap {
  module: string;
  path: string;
  /** False for an `*-unsigned.hap`, which targets that verify signatures reject. */
  signed: boolean;
}

/**
 * The HAP to install from {@link discoverHaps} output: a module's newest signed
 * HAP, else its newest unsigned one. Without `module`, the single module that
 * has a signed HAP, else the single one that has any HAP. Null when nothing is
 * built; throws when several modules qualify and none was named.
 */
export function pickHap(haps: Record<string, ModuleHaps>, module?: string): PickedHap | null {
  const pick = (name: string): PickedHap | null => {
    const signed = haps[name]?.signed[0];
    if (signed) return { module: name, path: signed, signed: true };
    const unsigned = haps[name]?.unsigned[0];
    return unsigned ? { module: name, path: unsigned, signed: false } : null;
  };
  if (module) return pick(module);
  const names = Object.keys(haps);
  const withSigned = names.filter((n) => haps[n]!.signed.length > 0);
  const candidates = withSigned.length > 0 ? withSigned : names.filter((n) => haps[n]!.unsigned.length > 0);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new OniroError(`Multiple modules have built HAPs (${candidates.join(', ')}). Pass a module to choose.`);
  }
  return pick(candidates[0]!);
}
