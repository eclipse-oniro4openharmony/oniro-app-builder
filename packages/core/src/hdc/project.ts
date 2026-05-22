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
 * Read the main ability from `<module>/src/main/module.json5`. Defaults to `entry`
 * for the module folder name if not provided — projects with custom module names
 * should pass it explicitly.
 */
export function getMainAbility(projectDir: string, moduleName = 'entry'): string {
  const moduleJsonPath = path.join(projectDir, moduleName, 'src', 'main', 'module.json5');
  if (!fs.existsSync(moduleJsonPath)) {
    throw new OniroError(`Could not find module.json5 at ${moduleJsonPath}`);
  }
  const moduleJson = readJson5<{ module?: { mainElement?: string } }>(moduleJsonPath);
  if (!moduleJson.module?.mainElement) {
    throw new OniroError('mainElement not found in module.json5');
  }
  return moduleJson.module.mainElement;
}
