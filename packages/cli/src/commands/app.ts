import { Command } from 'commander';
import * as path from 'node:path';
import { installApp, launchApp } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerAppCommand(program: Command): void {
  const app = program.command('app').description('Install and launch built apps on a connected device/emulator.');

  app
    .command('install [project-dir]')
    .description('Install the signed .hap on the connected device/emulator via hdc.')
    .option('--hap <path>', 'Override the .hap path (relative to project-dir or absolute).')
    .action(async (projectDir: string | undefined, opts: { hap?: string }) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      logger.info(`Installing app from ${dir}...`);
      await installApp({ config, projectDir: dir, hapPath: opts.hap, logger });
      logger.info('App installed.');
    });

  app
    .command('launch [project-dir]')
    .description('Launch the app on the connected device/emulator via hdc.')
    .option('--module <module>', 'Module folder name', 'entry')
    .action(async (projectDir: string | undefined, opts: { module: string }) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      logger.info(`Launching app from ${dir}...`);
      await launchApp({ config, projectDir: dir, moduleName: opts.module, logger });
      logger.info('App launched.');
    });
}
