import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ALL_SDKS,
  downloadAndInstallSdk,
  getOsFolder,
  getSdkRootDir,
  getSupportedSdksForUi,
  removeSdk,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerSdkCommand(program: Command): void {
  const sdk = program.command('sdk').description('Manage OpenHarmony SDK installs.');

  sdk
    .command('install <version>')
    .description('Download and install an OpenHarmony SDK. Skips if already installed.')
    .option('--force', 'Reinstall even if the SDK is already present.')
    .action(async (version: string, opts: { force?: boolean }) => {
      const { config, logger, progress } = getRuntime();
      const release = ALL_SDKS.find((s) => s.version === version);
      if (!release) {
        throw new Error(
          `Unknown SDK version "${version}". Known: ${ALL_SDKS.map((s) => s.version).join(', ')}`,
        );
      }
      const sdkInstallDir = path.join(getSdkRootDir(config), getOsFolder(), release.api);
      if (fs.existsSync(sdkInstallDir) && !opts.force) {
        logger.info(
          `SDK ${release.version} (api ${release.api}) already installed at ${sdkInstallDir}; pass --force to reinstall.`,
        );
        return;
      }
      logger.info(`Installing OpenHarmony SDK ${release.version} (api ${release.api})...`);
      await downloadAndInstallSdk({ config, version: release.version, api: release.api, progress, logger });
      logger.info('SDK installed.');
    });

  sdk
    .command('list')
    .description('List known SDK versions and whether they are installed on this machine.')
    .option('--json', 'Emit machine-readable JSON instead of a table.')
    .action((opts: { json?: boolean }) => {
      const { config } = getRuntime();
      const sdks = getSupportedSdksForUi(config);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(sdks, null, 2)}\n`);
        return;
      }
      const rows = sdks.map((s) => `${s.installed ? '*' : ' '}  ${s.version.padEnd(8)} api ${s.api}`);
      process.stdout.write(`${rows.join('\n')}\n`);
    });

  sdk
    .command('remove <api>')
    .description('Remove an installed SDK by API level (e.g. 18, 20).')
    .action((api: string) => {
      const { config, logger } = getRuntime();
      const removed = removeSdk(config, api);
      if (!removed) {
        logger.warn(`No SDK with api ${api} found under the configured SDK root.`);
        process.exit(1);
      }
      logger.info(`Removed SDK api ${api}.`);
    });
}
