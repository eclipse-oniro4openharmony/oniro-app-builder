import { Command } from 'commander';
import * as path from 'node:path';
import { SdkNotInstalledError, buildHap, downloadAndInstallSdk } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface BuildOpts {
  product: string;
  module?: string;
  mode?: string;
  task: string;
  deps: boolean;
  parallel: boolean;
  installSdk?: boolean;
  json?: boolean;
}

export function registerBuildCommand(program: Command): void {
  program
    .command('build [project-dir]')
    .description(
      'Build an OpenHarmony or HarmonyOS app via hvigorw. Defaults to the current directory. ' +
        'Projects declaring runtimeOS "HarmonyOS" build against the HarmonyOS SDK (ONIRO_HARMONYOS_SDK_PATH or an installed DevEco Studio). ' +
        'An OpenHarmony project fails early, naming the release to install, when the SDK for its compileSdkVersion is missing.',
    )
    .option('--product <product>', 'hvigor product name', 'default')
    .option('--module <module>', 'restrict the build to a specific module')
    .option('--mode <mode>', 'hvigor build mode (e.g. release, debug)')
    .option('--task <task>', 'hvigor task to run', 'assembleHap')
    .option('--no-deps', 'skip the automatic `ohpm install --all` when oh_modules/ is missing')
    .option('--no-parallel', 'build modules serially (default: parallel)')
    .option('--install-sdk', 'install the OpenHarmony SDK the project compiles against when it is missing, then build')
    .option('--json', 'emit the build result (discovered HAPs, warnings) as JSON')
    .action(async (projectDir: string | undefined, opts: BuildOpts) => {
      const { config, logger, progress } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      logger.info(`Building project at ${dir}...`);
      const build = () =>
        buildHap({
          config,
          projectDir: dir,
          product: opts.product,
          module: opts.module,
          mode: opts.mode,
          task: opts.task,
          autoInstallDeps: opts.deps,
          parallel: opts.parallel,
          logger,
          // The logger already echoes spawn output; this hook is for streaming to other UIs.
          onOutput: () => {},
        });
      let result;
      try {
        result = await build();
      } catch (err) {
        if (!(err instanceof SdkNotInstalledError && err.version && opts.installSdk)) throw err;
        logger.info(`Installing OpenHarmony SDK ${err.version} (api ${err.api}), which the project compiles against...`);
        await downloadAndInstallSdk({ config, version: err.version, api: err.api, progress, logger });
        result = await build();
      }
      for (const w of result.warnings) logger.warn(w);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
      logger.info('Build complete.');
    });
}
