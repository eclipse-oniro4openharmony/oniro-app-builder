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
  harmonyOsSignHap,
  signOpenHarmonyHap,
  prepareSigning,
  getOhosBaseSdkHome,
  describeProfileValidity,
  describeSigningMaterial,
  type Apl,
  type AppFeature,
  type HarmonyOsSigningResult,
  type SigningMaterialSummary,
  type SigningPasswords,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

/** `profile names 6 device(s), debug, valid until 2026-10-01 11:50 UTC`. */
function profileSummary(result: HarmonyOsSigningResult): string {
  const validity = describeProfileValidity({ type: result.profileType, notAfter: result.notAfter });
  return [`profile names ${result.deviceIds.length} device(s)`, validity].filter(Boolean).join(', ');
}

/** ` (release profile, apl normal; certificate valid until …)`, or nothing when nothing is known. */
function materialSuffix(summary: SigningMaterialSummary): string {
  const text = describeSigningMaterial(summary);
  return text ? ` (${text})` : '';
}

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
        'With --hap <file>, signs a prebuilt HAP instead of a project (with --harmonyos, for HarmonyOS).',
        'Ends by naming the profile type and expiry; `oniro-app app verify <hap>` checks what signed a built HAP.',
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
    .addOption(
      new Option(
        '--app-privilege-capabilities <list>',
        'Comma-separated privileges to write into the profile\'s app-privilege-capabilities. An app that declares a privileged extension ability (e.g. an AccessibilityExtensionAbility) needs AllowAppUsePrivilegeExtension, else install fails with 9568344 "not allow use privilege extension". Others include AllowAppMultiProcess and AllowAppDesktopIconHide.',
      ).argParser(parseAclsList),
    )
    .option(
      '--harmonyos',
      'Sign a HarmonyOS project through AppGallery Connect. Needs `oniro-app auth login`, and a device registered to the team: a connected device is registered if it reports a UDID (`hdc shell bm get -u`).',
    )
    .option(
      '--hap <file>',
      'Sign this prebuilt .hap (unsigned, or signed with other material) instead of a project, and write a signed copy (see --out). The bundle name is read from the HAP. For OpenHarmony, --apl, --app-feature, --acls and --app-privilege-capabilities apply as for a project; with --harmonyos, the ACL permissions are read from the HAP too.',
    )
    .option(
      '--out <file>',
      'With --hap: where to write the signed HAP. Default: next to the input, `<name>-unsigned.hap` → `<name>-signed.hap`, `<name>.hap` → `<name>-signed.hap`, `<name>-signed.hap` → `<name>-resigned.hap`. Name the input itself to re-sign it in place.',
    )
    .option('--team-id <id>', 'With --harmonyos: the AGC team to sign under. Default: the account\'s own (`oniro-app auth team list`).')
    .option(
      '--product <name>',
      'The product to sign for. OpenHarmony: its runtimeOS and compileSdkVersion pick the certificate and the SDK the signing files come from (default: the first product). With --harmonyos: the product whose signingConfig is written (default `default`).',
    )
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
          appPrivilegeCapabilities?: string[];
          bootstrap?: boolean;
          storePassword?: string;
          keyPassword?: string;
          harmonyos?: boolean;
          teamId?: string;
          product?: string;
          force?: boolean;
          hap?: string;
          out?: string;
        },
      ) => {
        const { config, logger } = getRuntime();
        const dir = path.resolve(projectDir ?? process.cwd());
        const passwords: SigningPasswords | undefined =
          opts.storePassword || opts.keyPassword
            ? { store: opts.storePassword ?? '123456', key: opts.keyPassword ?? '123456' }
            : undefined;

        if (opts.out && !opts.hap) throw new OniroError('--out names where `--hap` writes the signed HAP; pass --hap too.');
        if (opts.hap) {
          if (projectDir) throw new OniroError('Pass either a project directory or --hap, not both.');
          if (opts.product || opts.bootstrap) {
            throw new OniroError(`--${opts.product ? 'product' : 'bootstrap'} applies to a project, not to --hap.`);
          }
          // Each signing path honours only its own flags; say so rather than drop one.
          const ignored = opts.harmonyos
            ? [
                opts.apl !== 'normal' && '--apl',
                opts.appFeature && '--app-feature',
                opts.acls && '--acls (the ACLs are read from the HAP)',
                opts.appPrivilegeCapabilities && '--app-privilege-capabilities',
                (opts.storePassword || opts.keyPassword) && '--store-password/--key-password',
              ]
            : [opts.teamId && '--team-id', opts.force && '--force'];
          const unsupported = ignored.filter((flag): flag is string => typeof flag === 'string');
          if (unsupported.length > 0) {
            throw new OniroError(
              `${unsupported.join(', ')} ${unsupported.length > 1 ? 'do' : 'does'} not apply to ${opts.harmonyos ? '--harmonyos --hap' : '--hap without --harmonyos'}.`,
            );
          }
          if (!opts.harmonyos) {
            const result = await signOpenHarmonyHap({
              hapPath: opts.hap,
              outPath: opts.out,
              sdkHome: getOhosBaseSdkHome(config),
              apl: opts.apl,
              appFeature: opts.appFeature,
              acls: opts.acls,
              appPrivilegeCapabilities: opts.appPrivilegeCapabilities,
              passwords,
              applicationCertPath: config.get('applicationCertPath', '') || undefined,
              logger,
            });
            logger.info(`Signed ${result.bundleName} into ${result.outPath}${materialSuffix(result.material)}.`);
            return;
          }
          const result = await harmonyOsSignHap({
            config,
            session: createHarmonyOsSession({ config, logger }),
            hapPath: opts.hap,
            outPath: opts.out,
            teamId: opts.teamId,
            force: opts.force,
            logger,
          });
          logger.info(`Signed ${result.bundleName} into ${result.outPath} (${profileSummary(result)}).`);
          return;
        }

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
          logger.info(`Signing configs ready for ${result.bundleName} (${profileSummary(result)}).`);
          return;
        }
        // The OpenHarmony development certificate cannot sign for a HarmonyOS device.
        if (detectRuntimeOs(dir, opts.product) === 'HarmonyOS') {
          throw new OniroError(
            `${dir} targets HarmonyOS, which needs a certificate from AppGallery Connect: run \`oniro-app auth login\` once, then \`oniro-app sign --harmonyos\`.`,
          );
        }

        if (opts.bootstrap) {
          const result = prepareSigning({
            config,
            projectDir: dir,
            apl: opts.apl,
            appFeature: opts.appFeature,
            acls: opts.acls,
            appPrivilegeCapabilities: opts.appPrivilegeCapabilities,
            passwords,
            product: opts.product,
            logger,
          });
          logger.info(result.source === 'present' ? 'Signing material already present.' : 'Signing configs generated.');
          return;
        }

        const sdkHome = getOhosBaseSdkHome(config);
        logger.info(`Generating signing configs in ${dir} using SDK at ${sdkHome}...`);
        const generated = generateSigningConfigs({
          projectDir: dir,
          sdkHome,
          apl: opts.apl,
          appFeature: opts.appFeature,
          acls: opts.acls,
          appPrivilegeCapabilities: opts.appPrivilegeCapabilities,
          passwords,
          product: opts.product,
          logger,
        });
        logger.info(`Signing configs generated${materialSuffix(generated)}.`);
      },
    );
}
