import { Command } from 'commander';
import * as path from 'node:path';
import { installApp, launchApp, uninstallApp, forceStop, applyChanges } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface ApplyOpts {
  bundle: string;
  module?: string;
  hap?: string;
  installedHap?: string;
  system?: boolean;
  allowUninstall?: boolean;
  device?: string;
  json?: boolean;
}

export function registerAppCommand(program: Command): void {
  const app = program.command('app').description('Install, launch, and manage built apps on a connected device/emulator.');

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
    .option('--ability <name>', 'Explicit ability to launch (defaults to the module mainElement / first visible).')
    .action(async (projectDir: string | undefined, opts: { module: string; ability?: string }) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      logger.info(`Launching app from ${dir}...`);
      await launchApp({ config, projectDir: dir, moduleName: opts.module, abilityName: opts.ability, logger });
      logger.info('App launched.');
    });

  app
    .command('apply [project-dir]')
    .description(
      'Install a HAP and verify the running process took the change. Handles sign-info mismatch, ' +
        'asset-cache invalidation, and persistent-bundle restart.',
    )
    .requiredOption('--bundle <bundle>', 'Bundle name to apply changes to.')
    .option('--module <module>', 'Module to resolve the HAP from (multi-module projects).')
    .option('--hap <path>', 'Explicit .hap path (relative to project-dir or absolute).')
    .option('--installed-hap <path>', 'Local path to the currently-installed HAP, to enable the asset-cache reboot.')
    .option('--system', 'Treat as a persistent/system bundle (refuses uninstall on sign-info mismatch).')
    .option('--allow-uninstall', 'Permit uninstalling a system bundle on sign-info mismatch (dangerous).')
    .option('--device <serial>', 'Target device serial.')
    .option('--json', 'Emit the result as JSON.')
    .action(async (projectDir: string | undefined, opts: ApplyOpts) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      const result = await applyChanges({
        config,
        bundle: opts.bundle,
        hapPath: opts.hap,
        projectDir: dir,
        module: opts.module,
        installedHapPath: opts.installedHap,
        isSystemBundle: opts.system,
        allowUninstall: opts.allowUninstall,
        deviceSerial: opts.device,
        logger,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        logger.info(
          `apply: method=${result.method} pid ${result.preInstallPid ?? '-'} -> ${result.postInstallPid ?? '-'}` +
            `${result.cacheCleared ? ' (cache cleared)' : ''}`,
        );
      }
    });

  app
    .command('uninstall <bundle>')
    .description('Uninstall an app by bundle name.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (bundle: string, opts: { device?: string }) => {
      const { config, logger } = getRuntime();
      await uninstallApp({ config, bundle, deviceSerial: opts.device, logger });
      logger.info(`Uninstalled ${bundle}.`);
    });

  app
    .command('stop <bundle>')
    .description('Force-stop an app by bundle name.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (bundle: string, opts: { device?: string }) => {
      const { config, logger } = getRuntime();
      await forceStop({ config, bundle, deviceSerial: opts.device, logger });
      logger.info(`Stopped ${bundle}.`);
    });
}
