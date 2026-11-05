import { Command } from 'commander';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installApp,
  launchApp,
  uninstallApp,
  forceStop,
  applyChanges,
  existingHapOrUnsigned,
  getBundleName,
  readHapBundleName,
  smokeCheck,
  latestCrash,
  wakeAndUnlock,
  DEFAULT_SMOKE_DELAY_MS,
  OniroError,
  type ConfigProvider,
  type Logger,
  type CrashVerdict,
  type SmokeResult,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { decodeGreyscale } from '../lib/screenshotImage.js';

interface SmokeOpts {
  smoke?: boolean;
  smokeDelay: string;
  smokeScreenshot?: string;
}

function addSmokeOptions(cmd: Command): Command {
  return cmd
    .option(
      '--smoke',
      'After launch, wait for the process, take a screenshot after --smoke-delay, and fail (exit 1) when the ' +
        'process died or the screen is blank.',
    )
    .option('--smoke-delay <ms>', 'With --smoke: wait between the process appearing and the screenshot.', String(DEFAULT_SMOKE_DELAY_MS))
    .option('--smoke-screenshot <file>', 'With --smoke: where to write the screenshot (default: a file in the system temp dir).');
}

function smokeDelayFrom(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new OniroError(`--smoke-delay expects a number of milliseconds; got "${raw}".`);
  return Math.round(n);
}

/**
 * A dark screen would read as a blank app, and `aa start` refuses to launch
 * over a lock screen, so turn the screen on and swipe the lock away first.
 */
async function wakeForSmoke(config: ConfigProvider, logger: Logger, device?: string): Promise<void> {
  const screen = await wakeAndUnlock({ config, deviceSerial: device, logger }).catch((err: Error) => {
    logger.warn(`Could not wake the screen: ${err.message}`);
    return null;
  });
  if (screen?.locked) logger.warn('The lock screen asks for a credential; the smoke screenshot will show it.');
}

/** How far behind the host the device clock may run before a launch's crash is missed. */
const CRASH_CLOCK_SLACK_MS = 2_000;
/** How long to wait for the faultlog of an app that died after launch. */
const CRASH_WAIT_MS = 15_000;

/** The launch smoke check, with sharp decoding the screenshot and the faultlog reader for crashes. */
function runSmoke(
  config: ConfigProvider,
  logger: Logger,
  bundle: string,
  since: Date,
  opts: SmokeOpts & { device?: string },
): Promise<SmokeResult<CrashVerdict>> {
  const screenshotPath = opts.smokeScreenshot
    ? path.resolve(opts.smokeScreenshot)
    : path.join(os.tmpdir(), `oniro-smoke-${bundle}-${since.getTime()}.jpeg`);
  return smokeCheck({
    config,
    bundle,
    since,
    delayMs: smokeDelayFrom(opts.smokeDelay),
    screenshotPath,
    decodeGreyscale: (jpeg) => decodeGreyscale(jpeg),
    crashProbe: (probe) =>
      latestCrash({
        config: probe.config,
        bundle: probe.bundle,
        // Faultlog times are the device's clock: allow it to run a little behind.
        since: new Date(probe.since.getTime() - CRASH_CLOCK_SLACK_MS),
        // hiview writes the faultlog seconds after a death; a live app is looked up once.
        waitMs: probe.alive ? 0 : CRASH_WAIT_MS,
        deviceSerial: probe.deviceSerial,
        logger: probe.logger,
      }),
    deviceSerial: opts.device,
    logger,
  });
}

/** One line for the smoke verdict. */
export function formatSmoke(s: SmokeResult<CrashVerdict>): string {
  const parts = [
    s.pid === null ? 'no process' : `pid ${s.pid} ${s.alive ? 'alive' : 'died'}`,
    s.blankScreen === null ? 'blank check skipped' : `${s.blankScreen ? 'blank' : 'not blank'} (score ${s.blankScore})`,
  ];
  if (s.crash) {
    const where = s.crash.file ? ` at ${s.crash.file}:${s.crash.line ?? '?'}` : '';
    parts.push(`${s.crash.kind ?? 'crash'}${s.crash.reason ? ` (${s.crash.reason})` : ''}${where}`);
  }
  if (s.screenshot) parts.push(`screenshot ${s.screenshot}`);
  return `smoke: ${s.passed ? 'passed' : `FAILED (${s.failures.join('; ')})`}: ${parts.join(', ')}`;
}

interface LaunchOpts extends SmokeOpts {
  bundle?: string;
  module: string;
  ability?: string;
  device?: string;
  json?: boolean;
}

interface ApplyOpts extends SmokeOpts {
  bundle?: string;
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
    .command('install [project-dir-or-hap]')
    .description(
      'Install a built .hap on the connected device/emulator via hdc. Takes a project dir (default: the ' +
        'current one), whose newest signed HAP is installed, else its unsigned one, or a .hap file. Fails ' +
        'when the bundle manager rejects the HAP, and says how to sign when a target refuses an unsigned one.',
    )
    .option('--hap <path>', 'Override the .hap path (relative to project-dir or absolute).')
    .option('--device <serial>', 'Target device serial.')
    .action(async (target: string | undefined, opts: { hap?: string; device?: string }) => {
      const { config, logger } = getRuntime();
      const isHap = target !== undefined && /\.hap$/i.test(target);
      const dir = isHap ? process.cwd() : path.resolve(target ?? process.cwd());
      const hapPath = isHap ? path.resolve(target) : opts.hap;
      logger.info(`Installing ${hapPath ?? `app from ${dir}`}...`);
      const result = await installApp({ config, projectDir: dir, hapPath, deviceSerial: opts.device, logger });
      logger.info(`Installed ${result.hapPath}.`);
    });

  const launch = app
    .command('launch [project-dir]')
    .description(
      'Launch an app on the connected device/emulator. Project mode (default): resolves ' +
        'bundle + main ability from the project. Bundle mode (--bundle): launch an ' +
        'already-installed app by bundle name, no project needed.',
    )
    .option('--bundle <bundle>', 'Launch an already-installed app by bundle name (no project needed).')
    .option('--module <module>', 'Module folder name (project mode).', 'entry')
    .option('--ability <name>', 'Explicit ability to launch (defaults to the module mainElement in project mode, or the installed bundle main ability in --bundle mode).')
    .option('--device <serial>', 'Target device serial.');
  addSmokeOptions(launch)
    .option('--json', 'With --smoke: emit `{ bundle, smoke }` as JSON.')
    .action(async (projectDir: string | undefined, opts: LaunchOpts) => {
      const { config, logger } = getRuntime();
      if (opts.smoke) {
        smokeDelayFrom(opts.smokeDelay); // validate before launching
        await wakeForSmoke(config, logger, opts.device);
      }
      const since = new Date();
      let bundle: string;
      if (opts.bundle) {
        bundle = opts.bundle;
        logger.info(`Launching installed bundle ${opts.bundle}...`);
        await launchApp({ config, bundleName: opts.bundle, abilityName: opts.ability, deviceSerial: opts.device, logger });
      } else {
        const dir = path.resolve(projectDir ?? process.cwd());
        bundle = getBundleName(dir);
        logger.info(`Launching app from ${dir}...`);
        await launchApp({ config, projectDir: dir, moduleName: opts.module, abilityName: opts.ability, deviceSerial: opts.device, logger });
      }
      logger.info('App launched.');
      if (!opts.smoke) return;
      const smoke = await runSmoke(config, logger, bundle, since, opts);
      if (opts.json) process.stdout.write(`${JSON.stringify({ bundle, smoke }, null, 2)}\n`);
      else process.stdout.write(`${formatSmoke(smoke)}\n`);
      if (!smoke.passed) process.exitCode = 1;
    });

  const apply = app
    .command('apply [project-dir-or-hap]')
    .description(
      'Install a HAP (a project dir, default the current one, or a .hap file) and verify the running process ' +
        'took the change. Refuses a HAP of another bundle. Handles sign-info mismatch, asset-cache invalidation, ' +
        'and persistent-bundle restart.',
    )
    .option(
      '--bundle <bundle>',
      'Bundle name to apply changes to. Defaults to the bundleName in the .hap file, else in the project AppScope/app.json5.',
    )
    .option('--module <module>', 'Module to resolve the HAP from (multi-module projects).')
    .option('--hap <path>', 'Explicit .hap path (relative to project-dir or absolute).')
    .option('--installed-hap <path>', 'Local path to the currently-installed HAP, to enable the asset-cache reboot.')
    .option('--system', 'Treat as a persistent/system bundle (refuses uninstall on sign-info mismatch).')
    .option('--allow-uninstall', 'Permit uninstalling a system bundle on sign-info mismatch (dangerous).')
    .option('--device <serial>', 'Target device serial.')
    .option('--json', 'Emit the result as JSON (with --smoke, plus a `smoke` object).');
  addSmokeOptions(apply)
    .action(async (target: string | undefined, opts: ApplyOpts) => {
      const { config, logger } = getRuntime();
      if (opts.smoke) smokeDelayFrom(opts.smokeDelay); // validate before installing
      const isHap = target !== undefined && /\.hap$/i.test(target);
      if (isHap && opts.hap) throw new OniroError('Pass the HAP either as the argument or with --hap, not both.');
      const dir = isHap ? process.cwd() : path.resolve(target ?? process.cwd());
      const hapPath = isHap ? path.resolve(target) : opts.hap;
      let bundle = opts.bundle;
      if (!bundle && isHap) {
        // The same signed-to-unsigned fallback applyChanges applies when it installs.
        const hap = existingHapOrUnsigned(hapPath!);
        if (!hap) throw new OniroError(`HAP not found at ${hapPath}.`);
        bundle = (await readHapBundleName(hap.path).catch(() => null)) ?? undefined;
        if (!bundle) throw new OniroError(`Could not read the bundle name from ${hap.path}. Pass --bundle.`);
      }
      bundle ??= getBundleName(dir);
      const result = await applyChanges({
        config,
        bundle,
        hapPath,
        projectDir: dir,
        module: opts.module,
        installedHapPath: opts.installedHap,
        isSystemBundle: opts.system,
        allowUninstall: opts.allowUninstall,
        deviceSerial: opts.device,
        logger,
      });
      let smoke: SmokeResult<CrashVerdict> | undefined;
      if (opts.smoke) {
        // A replace install stops the app, so launch it again before judging it.
        await wakeForSmoke(config, logger, opts.device);
        const since = new Date();
        logger.info(`Launching ${bundle} for the smoke check...`);
        await launchApp({ config, bundleName: bundle, deviceSerial: opts.device, logger });
        smoke = await runSmoke(config, logger, bundle, since, opts);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(smoke ? { ...result, smoke } : result, null, 2)}\n`);
      } else {
        logger.info(
          `apply: method=${result.method} pid ${result.preInstallPid ?? '-'} -> ${result.postInstallPid ?? '-'}` +
            `${result.cacheCleared ? ' (cache cleared)' : ''}`,
        );
        if (smoke) process.stdout.write(`${formatSmoke(smoke)}\n`);
      }
      if (smoke && !smoke.passed) process.exitCode = 1;
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
