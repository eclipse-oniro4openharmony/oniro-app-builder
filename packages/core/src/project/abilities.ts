import * as fs from 'node:fs';
import * as path from 'node:path';
import { OniroError } from '../ports/errors.js';
import { readJson5File } from './jsonHelpers.js';

export interface AbilityInfo {
  name: string;
  type?: string;
  visible?: boolean;
  srcEntry?: string;
}

interface ModuleJson {
  module?: { abilities?: Array<{ name?: string; type?: string; visible?: boolean; srcEntry?: string }> };
}

/**
 * Read all abilities declared in a module's `module.json5` `abilities[]`.
 * Defaults to the `entry` module folder.
 */
export function listAbilities(opts: { projectDir: string; moduleName?: string }): AbilityInfo[] {
  const moduleName = opts.moduleName ?? 'entry';
  const moduleJsonPath = path.join(opts.projectDir, moduleName, 'src', 'main', 'module.json5');
  if (!fs.existsSync(moduleJsonPath)) {
    throw new OniroError(`Could not find module.json5 at ${moduleJsonPath}`);
  }
  const parsed = readJson5File<ModuleJson>(moduleJsonPath);
  return (parsed.module?.abilities ?? [])
    .filter((a): a is { name: string; type?: string; visible?: boolean; srcEntry?: string } => Boolean(a.name))
    .map((a) => ({ name: a.name, type: a.type, visible: a.visible, srcEntry: a.srcEntry }));
}
