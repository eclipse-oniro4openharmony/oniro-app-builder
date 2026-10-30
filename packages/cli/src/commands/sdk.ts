import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ALL_SDKS,
  OHOS_DAILY_BUILDS_URL,
  downloadAndInstallSdk,
  getOsFolder,
  getSdkRootDir,
  getSupportedSdksForUi,
  installSdkFromArchive,
  removeSdk,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

const FULL_SDK_TIP =
  'Tip: the full SDK (with system APIs) is not on the release mirror. Download an ohos-sdk-full archive ' +
  `from the OpenHarmony daily builds, ${OHOS_DAILY_BUILDS_URL}, and install it with ` +
  '`oniro-app sdk install --from-archive <archive>`.';

export function registerSdkCommand(program: Command): void {
  const sdk = program.command('sdk').description('Manage OpenHarmony SDK installs.');

  sdk
    .command('install [version]')
    .description(
      'Download and install an OpenHarmony SDK (skips if already installed), or install one from a local ' +
        'archive with --from-archive.',
    )
    .option(
      '--from-archive <path>',
      'Install from a local SDK .tar.gz instead of downloading, e.g. the full SDK. The API level is read ' +
        'from the archive.',
    )
    .option('--force', 'Reinstall even if the SDK is already present.')
    .option(
      '--tmp-dir <path>',
      'Directory for download/extract temporaries (default: ONIRO_TMP_DIR, else .oniro-tmp next to ' +
        'the install target). Use this when that filesystem is short on space.',
    )
    .addHelpText('after', `\n${FULL_SDK_TIP}`)
    .action(async (version: string | undefined, opts: { fromArchive?: string; force?: boolean; tmpDir?: string }) => {
      const { config, logger, progress } = getRuntime();
      if (opts.fromArchive) {
        if (version) throw new Error('Pass either a version or --from-archive, not both.');
        const archivePath = path.resolve(opts.fromArchive);
        logger.info(`Installing OpenHarmony SDK from ${archivePath}...`);
        const installed = await installSdkFromArchive({
          config,
          archivePath,
          force: opts.force,
          progress,
          logger,
          tmpDir: opts.tmpDir,
        });
        const label = installed.version ? `SDK ${installed.version} (api ${installed.api})` : `SDK api ${installed.api}`;
        logger.info(`${label} installed at ${installed.dir}.`);
        return;
      }
      if (!version) {
        throw new Error(
          `Name an SDK version (${ALL_SDKS.map((s) => s.version).join(', ')}) or pass --from-archive <path>.\n` +
            FULL_SDK_TIP,
        );
      }
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
      await downloadAndInstallSdk({
        config,
        version: release.version,
        api: release.api,
        progress,
        logger,
        tmpDir: opts.tmpDir,
      });
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
