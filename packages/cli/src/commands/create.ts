import { Command } from 'commander';
import * as path from 'node:path';
import {
  ALL_SDKS,
  createScaffold,
  isValidBundleName,
  isValidProjectName,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { getBundledTemplateRoot } from '../lib/templateRoot.js';

interface CreateOpts {
  name: string;
  bundle: string;
  location: string;
  sdk: string;
  template: string;
  module?: string;
  overwrite?: boolean;
}

export function registerCreateCommand(program: Command): void {
  program
    .command('create')
    .description('Scaffold a new Oniro/OpenHarmony app from a template. All flags are required (non-interactive).')
    .requiredOption('--name <name>', 'Project folder name (letters, digits, ._- only)')
    .requiredOption('--bundle <bundleName>', 'Bundle name in reverse-DNS form, e.g. com.example.myapp')
    .requiredOption('--location <dir>', 'Parent directory where the new project folder will be created')
    .requiredOption('--sdk <api>', 'Target SDK API level (e.g. 18, 20)')
    .option('--template <id>', 'Template id', 'EmptyAbility')
    .option('--module <name>', 'Module folder name (defaults to the template default, usually `entry`)')
    .option('--overwrite', 'Replace the destination if it already exists')
    .action(async (opts: CreateOpts) => {
      const { config, logger } = getRuntime();

      if (!isValidProjectName(opts.name)) {
        throw new Error(`Invalid --name '${opts.name}'. Use letters/numbers/._- and no slashes.`);
      }
      if (!isValidBundleName(opts.bundle)) {
        throw new Error(`Invalid --bundle '${opts.bundle}'. Example: com.example.myapp`);
      }
      const sdkApi = Number(opts.sdk);
      if (!Number.isFinite(sdkApi)) {
        throw new Error(`--sdk must be a numeric api level. Known: ${ALL_SDKS.map((s) => s.api).join(', ')}`);
      }

      const templateRoot = getBundledTemplateRoot();
      const result = await createScaffold({
        config,
        templateId: opts.template,
        projectName: opts.name,
        bundleName: opts.bundle,
        location: path.resolve(opts.location),
        sdkApi,
        moduleName: opts.module,
        templateRoot,
        overwrite: opts.overwrite,
        logger,
      });

      logger.info(`Project created at ${result.projectDir}`);
      process.stdout.write(`${result.projectDir}\n`);
    });
}
