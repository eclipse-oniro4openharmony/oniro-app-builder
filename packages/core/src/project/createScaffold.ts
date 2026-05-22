import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { getOhosBaseSdkHome } from '../sdk/paths.js';
import { listTemplates, validateTemplateLayout } from './templates.js';
import { isValidBundleName, isValidProjectName } from './validators.js';
import { readJson5File, readJsonFile, writeJson5File, writeJsonFile } from './jsonHelpers.js';

const IGNORED_DIRS = new Set(['oh_modules', 'node_modules', 'build', '.hvigor']);

export interface CreateScaffoldOptions {
  config: ConfigProvider;
  templateId: string;
  projectName: string;
  bundleName: string;
  /** Parent directory that will contain the new project folder. */
  location: string;
  sdkApi: number;
  /** Module folder name. Defaults to the template's `defaultModuleName`. */
  moduleName?: string;
  /** Absolute path to the directory containing template subfolders. */
  templateRoot: string;
  /** If the destination exists, remove it before scaffolding instead of throwing. */
  overwrite?: boolean;
  logger?: Logger;
}

export interface CreateScaffoldResult {
  projectDir: string;
}

/**
 * Async existence check.
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copy a template directory, skipping symlinks and template metadata.
 */
async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, dest);
    } else if (entry.isSymbolicLink()) {
      continue;
    } else if (entry.isFile()) {
      if (entry.name === 'template.json') continue;
      await fs.promises.copyFile(src, dest);
    }
  }
}

/**
 * Normalize every .json5 file in `projectDir` to strict JSON formatting (quoted keys).
 * Keeps JSON5 parsers happy while letting VS Code's built-in JSON parser handle them.
 */
async function normalizeJson5ToJson(projectDir: string, logger: Logger): Promise<void> {
  const stack: string[] = [projectDir];
  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json5')) continue;
      try {
        const parsed = readJson5File<unknown>(fullPath);
        writeJson5File(fullPath, parsed);
      } catch (err) {
        logger.warn(`Failed to normalize ${fullPath}: ${String(err)}`);
      }
    }
  }
}

function toJavaPropertiesPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '\\\\') : p;
}

function createOrUpdateLocalProperties(projectDir: string, sdkDir: string): void {
  const content = `sdk.dir=${toJavaPropertiesPath(sdkDir)}\n`;
  fs.writeFileSync(path.join(projectDir, 'local.properties'), content, 'utf8');
}

function renameIfExists(fromPath: string, toPath: string): void {
  if (fs.existsSync(fromPath) && fromPath !== toPath) {
    fs.renameSync(fromPath, toPath);
  }
}

/**
 * Apply user-selected names/versions to template files. Mirrors the writes done by
 * the extension's `updateTemplateConfigs` so a scaffold is identical regardless of
 * which frontend produced it.
 */
function updateTemplateConfigs(
  projectDir: string,
  args: {
    projectName: string;
    bundleName: string;
    sdkApi: number;
    moduleName: string;
  },
  sdkBaseDir: string,
): void {
  // 1) AppScope/app.json5 -> bundleName
  const appJsonPath = path.join(projectDir, 'AppScope', 'app.json5');
  if (fs.existsSync(appJsonPath)) {
    const appJson = readJson5File<{ app?: { bundleName?: string } }>(appJsonPath);
    appJson.app = appJson.app ?? {};
    appJson.app.bundleName = args.bundleName;
    writeJson5File(appJsonPath, appJson);
  }

  // 2) AppScope/resources/base/element/string.json -> app_name = projectName
  const stringsPath = path.join(projectDir, 'AppScope', 'resources', 'base', 'element', 'string.json');
  if (fs.existsSync(stringsPath)) {
    const strings = readJsonFile<{ string?: Array<{ name?: string; value?: string }> }>(stringsPath);
    if (Array.isArray(strings.string)) {
      const appName = strings.string.find((s) => s.name === 'app_name');
      if (appName) appName.value = args.projectName;
    }
    writeJsonFile(stringsPath, strings);
  }

  // 3) build-profile.json5 -> sdk + module name + srcPath
  const buildProfilePath = path.join(projectDir, 'build-profile.json5');
  if (fs.existsSync(buildProfilePath)) {
    const buildProfile = readJson5File<{
      app?: { products?: Array<{ compileSdkVersion?: number; compatibleSdkVersion?: number }> };
      modules?: Array<{ name?: string; srcPath?: string }>;
    }>(buildProfilePath);
    buildProfile.app = buildProfile.app ?? {};
    if (Array.isArray(buildProfile.app.products) && buildProfile.app.products.length > 0) {
      buildProfile.app.products[0]!.compileSdkVersion = args.sdkApi;
      buildProfile.app.products[0]!.compatibleSdkVersion = args.sdkApi;
    }
    if (Array.isArray(buildProfile.modules) && buildProfile.modules.length > 0) {
      buildProfile.modules[0]!.name = args.moduleName;
      buildProfile.modules[0]!.srcPath = `./${args.moduleName}`;
    }
    writeJson5File(buildProfilePath, buildProfile);
  }

  // 4) <module>/src/main/module.json5 -> module.name
  const moduleJsonPath = path.join(projectDir, args.moduleName, 'src', 'main', 'module.json5');
  if (fs.existsSync(moduleJsonPath)) {
    const moduleJson = readJson5File<{ module?: { name?: string } }>(moduleJsonPath);
    moduleJson.module = moduleJson.module ?? {};
    moduleJson.module.name = args.moduleName;
    writeJson5File(moduleJsonPath, moduleJson);
  }

  // 5) <module>/oh-package.json5 -> name
  const moduleOhPackagePath = path.join(projectDir, args.moduleName, 'oh-package.json5');
  if (fs.existsSync(moduleOhPackagePath)) {
    const pkg = readJson5File<{ name?: string }>(moduleOhPackagePath);
    pkg.name = args.moduleName;
    writeJson5File(moduleOhPackagePath, pkg);
  }

  // 6) .vscode/settings.json — useful for users who do open the project in VS Code.
  const vscodeDir = path.join(projectDir, '.vscode');
  fs.mkdirSync(vscodeDir, { recursive: true });
  const hapPath = `${args.moduleName}/build/default/outputs/default/${args.moduleName}-default-signed.hap`;
  writeJsonFile(path.join(vscodeDir, 'settings.json'), {
    'oniro.hapPath': hapPath,
    'files.associations': { '*.json5': 'jsonc' },
  });

  // 7) local.properties — sdk.dir must point at the OS base SDK home (containing API folders),
  //    NOT a specific API folder, otherwise hvigor double-nests the lookup.
  createOrUpdateLocalProperties(projectDir, sdkBaseDir);
}

/**
 * Scaffold a new Oniro/OpenHarmony project from a template. Returns the absolute path
 * to the created project directory.
 */
export async function createScaffold(opts: CreateScaffoldOptions): Promise<CreateScaffoldResult> {
  const logger = opts.logger ?? noopLogger;

  if (!isValidProjectName(opts.projectName)) {
    throw new OniroError(`Invalid project name '${opts.projectName}'. Use letters/numbers/._- and no slashes.`);
  }
  if (!isValidBundleName(opts.bundleName)) {
    throw new OniroError(`Invalid bundle name '${opts.bundleName}'. Example: com.example.myapplication`);
  }
  if (!opts.location || !(await pathExists(opts.location))) {
    throw new OniroError(`Location does not exist: ${opts.location}`);
  }

  const templateDir = path.join(opts.templateRoot, opts.templateId);
  if (!(await pathExists(templateDir))) {
    throw new OniroError(`Template not found: ${templateDir}`);
  }

  const templates = listTemplates(opts.templateRoot);
  const selected = templates.find((t) => t.id === opts.templateId);
  const defaultModuleName = selected?.defaultModuleName ?? 'entry';
  const moduleName = (opts.moduleName ?? defaultModuleName).trim() || defaultModuleName;

  const missing = validateTemplateLayout(templateDir, defaultModuleName);
  if (missing.length > 0) {
    throw new OniroError(`Template '${opts.templateId}' is missing required files:\n- ${missing.join('\n- ')}`);
  }

  const projectDir = path.join(opts.location, opts.projectName);
  if (await pathExists(projectDir)) {
    if (!opts.overwrite) {
      throw new OniroError(`Destination already exists: ${projectDir}. Pass overwrite: true to replace it.`);
    }
    await fs.promises.rm(projectDir, { recursive: true, force: true });
  }

  logger.info(`[create] Scaffolding ${opts.templateId} at ${projectDir}`);
  await copyDirRecursive(templateDir, projectDir);

  if (moduleName !== defaultModuleName) {
    renameIfExists(path.join(projectDir, defaultModuleName), path.join(projectDir, moduleName));
  }

  updateTemplateConfigs(
    projectDir,
    {
      projectName: opts.projectName,
      bundleName: opts.bundleName,
      sdkApi: opts.sdkApi,
      moduleName,
    },
    getOhosBaseSdkHome(opts.config),
  );

  await normalizeJson5ToJson(projectDir, logger);

  return { projectDir };
}
