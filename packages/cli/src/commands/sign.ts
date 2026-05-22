import { Command } from 'commander';
import * as path from 'node:path';
import { generateSigningConfigs, getOhosBaseSdkHome } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerSignCommand(program: Command): void {
  program
    .command('sign [project-dir]')
    .description('Generate signing keys, certificates, and signingConfigs for an OpenHarmony project. Requires java on PATH.')
    .action((projectDir: string | undefined) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      const sdkHome = getOhosBaseSdkHome(config);
      logger.info(`Generating signing configs in ${dir} using SDK at ${sdkHome}...`);
      generateSigningConfigs({ projectDir: dir, sdkHome, logger });
      logger.info('Signing configs generated.');
    });
}
