import { Command, Option } from 'commander';
import * as path from 'node:path';
import {
  APL_VALUES,
  APP_FEATURE_VALUES,
  OniroError,
  createHarmonyOsSession,
  detectRuntimeOs,
  generateSigningConfigs,
  harmonyOsAutoSign,
  prepareSigning,
  getOhosBaseSdkHome,
  type Apl,
  type AppFeature,
  type SigningPasswords,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

function parseAclsList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function registerSignCommand(program: Command): void {
  program
    .command('sign [project-dir]')
    .description(
      [
        'Generate signing keys, certificates, and signingConfigs for an OpenHarmony project.',
        'Requires java on PATH. The generated profile uses the SDK\'s built-in development',
        'cert (issuer=pki_internal) and its bundled validity window — dev/local builds only.',
        'Overwrites the `signingConfigs` block in build-profile.json5 (other keys preserved).',
        'HarmonyOS projects need --harmonyos instead, which has AppGallery Connect issue the',
        'certificate and profile for a signed-in Huawei account (`oniro-app auth login`).',
      ].join(' '),
    )
    .addOption(
      new Option(
        '--apl <level>',
        'Ability Privilege Level written into the profile. Apps that request permissions above `normal` (e.g. ohos.permission.GET_WIFI_INFO_INTERNAL) need system_basic or system_core, which also switches the HAP-signing key to "OpenHarmony Application Release".',
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
    .addOption(
      new Option(
        '--acls <list>',
        'Comma-separated permission names to write into the profile\'s acls.allowed-acls. Required for apps that request permissions above their apl (e.g. a system_basic app requesting ohos.permission.CAPTURE_SCREEN). Example: --acls ohos.permission.REBOOT,ohos.permission.INJECT_INPUT_EVENT',
      ).argParser(parseAclsList),
    )
    .option(
      '--harmonyos',
      'Sign a HarmonyOS project through AppGallery Connect. Needs `oniro-app auth login`, and a connected device unless the team already has devices registered.',
    )
    .option('--team-id <id>', 'With --harmonyos: the AGC team to sign under. Default: the account\'s own (`oniro-app auth team list`).')
    .option('--product <name>', 'With --harmonyos: the product to sign. Default `default`.')
    .option('--force', 'With --harmonyos: regenerate the certificate and profile even when they are still valid.')
    .option('--bootstrap', 'No-op if signing material is already present; otherwise generate it.')
    .option('--store-password <pwd>', 'Keystore store password (default 123456 — the SDK keystore password).')
    .option('--key-password <pwd>', 'Keystore key password (default 123456 — the SDK keystore password).')
    .action(
      async (
        projectDir: string | undefined,
        opts: {
          apl: Apl;
          appFeature?: AppFeature;
          acls?: string[];
          bootstrap?: boolean;
          storePassword?: string;
          keyPassword?: string;
          harmonyos?: boolean;
          teamId?: string;
          product?: string;
          force?: boolean;
        },
      ) => {
        const { config, logger } = getRuntime();
        const dir = path.resolve(projectDir ?? process.cwd());

        if (opts.harmonyos) {
          const result = await harmonyOsAutoSign({
            config,
            session: createHarmonyOsSession({ config, logger }),
            projectDir: dir,
            productName: opts.product,
            teamId: opts.teamId,
            force: opts.force,
            logger,
          });
          logger.info(`Signing configs ready for ${result.bundleName} (profile names ${result.deviceIds.length} device(s)).`);
          return;
        }
        // The OpenHarmony development certificate cannot sign for a HarmonyOS device.
        if (detectRuntimeOs(dir, opts.product) === 'HarmonyOS') {
          throw new OniroError(
            `${dir} targets HarmonyOS, which needs a certificate from AppGallery Connect: run \`oniro-app auth login\` once, then \`oniro-app sign --harmonyos\`.`,
          );
        }
        const passwords: SigningPasswords | undefined =
          opts.storePassword || opts.keyPassword
            ? { store: opts.storePassword ?? '123456', key: opts.keyPassword ?? '123456' }
            : undefined;

        if (opts.bootstrap) {
          const result = prepareSigning({
            config,
            projectDir: dir,
            apl: opts.apl,
            appFeature: opts.appFeature,
            acls: opts.acls,
            passwords,
            logger,
          });
          logger.info(result.source === 'present' ? 'Signing material already present.' : 'Signing configs generated.');
          return;
        }

        const sdkHome = getOhosBaseSdkHome(config);
        logger.info(`Generating signing configs in ${dir} using SDK at ${sdkHome}...`);
        generateSigningConfigs({
          projectDir: dir,
          sdkHome,
          apl: opts.apl,
          appFeature: opts.appFeature,
          acls: opts.acls,
          passwords,
          logger,
        });
        logger.info('Signing configs generated.');
      },
    );
}
