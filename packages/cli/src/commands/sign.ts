import { Command, Option } from 'commander';
import * as path from 'node:path';
import {
  APL_VALUES,
  APP_FEATURE_VALUES,
  generateSigningConfigs,
  getOhosBaseSdkHome,
  type Apl,
  type AppFeature,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerSignCommand(program: Command): void {
  program
    .command('sign [project-dir]')
    .description(
      [
        'Generate signing keys, certificates, and signingConfigs for an OpenHarmony project.',
        'Requires java on PATH. The generated profile uses the SDK\'s built-in development',
        'cert (issuer=pki_internal) and its bundled validity window — dev/local builds only.',
        'Overwrites the `signingConfigs` block in build-profile.json5 (other keys preserved).',
      ].join(' '),
    )
    .addOption(
      new Option(
        '--apl <level>',
        'Ability Privilege Level written into the profile. Apps that request permissions above `normal` (e.g. ohos.permission.GET_WIFI_INFO_INTERNAL) need system_basic or system_core.',
      )
        .choices([...APL_VALUES])
        .default('normal'),
    )
    .addOption(
      new Option(
        '--app-feature <feature>',
        'App feature written into the profile. Defaults: hos_normal_app for apl=normal; hos_system_app for apl=system_basic/system_core.',
      ).choices([...APP_FEATURE_VALUES]),
    )
    .action((projectDir: string | undefined, opts: { apl: Apl; appFeature?: AppFeature }) => {
      const { config, logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      const sdkHome = getOhosBaseSdkHome(config);
      logger.info(`Generating signing configs in ${dir} using SDK at ${sdkHome}...`);
      generateSigningConfigs({
        projectDir: dir,
        sdkHome,
        apl: opts.apl,
        appFeature: opts.appFeature,
        logger,
      });
      logger.info('Signing configs generated.');
    });
}
