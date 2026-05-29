import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import { OniroError } from '../ports/errors.js';

function readJson5<T>(filePath: string): T {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON5.parse(content) as T;
}

/**
 * Read the project's bundle name from `AppScope/app.json5`.
 */
export function getBundleName(projectDir: string): string {
  const appJsonPath = path.join(projectDir, 'AppScope', 'app.json5');
  if (!fs.existsSync(appJsonPath)) {
    throw new OniroError(`Could not find app.json5 at ${appJsonPath}`);
  }
  const appJson = readJson5<{ app?: { bundleName?: string } }>(appJsonPath);
  if (!appJson.app?.bundleName) {
    throw new OniroError('bundleName not found in app.json5');
  }
  return appJson.app.bundleName;
}

/**
 * Read the ability to launch from `<module>/src/main/module.json5`. Defaults to
 * `entry` for the module folder name. Resolution order:
 *   1. `abilityName`, if given and present in `module.abilities[]`.
 *   2. `module.mainElement`.
 *   3. The first `visible` ability, then the first ability, from `module.abilities[]`.
 * Modules with multiple abilities can be targeted explicitly via `abilityName`.
 */
export function getMainAbility(projectDir: string, moduleName = 'entry', abilityName?: string): string {
  const moduleJsonPath = path.join(projectDir, moduleName, 'src', 'main', 'module.json5');
  if (!fs.existsSync(moduleJsonPath)) {
    throw new OniroError(`Could not find module.json5 at ${moduleJsonPath}`);
  }
  const moduleJson = readJson5<{
    module?: { mainElement?: string; abilities?: Array<{ name?: string; visible?: boolean }> };
  }>(moduleJsonPath);
  const module = moduleJson.module ?? {};

  if (abilityName) {
    const match = module.abilities?.find((a) => a.name === abilityName);
    if (match?.name) return match.name;
    throw new OniroError(`Ability "${abilityName}" not found in module.json5 at ${moduleJsonPath}`);
  }

  if (module.mainElement) return module.mainElement;

  const abilities = module.abilities ?? [];
  const visible = abilities.find((a) => a.visible && a.name);
  if (visible?.name) return visible.name;
  const first = abilities.find((a) => a.name);
  if (first?.name) return first.name;

  throw new OniroError('mainElement not found in module.json5');
}
