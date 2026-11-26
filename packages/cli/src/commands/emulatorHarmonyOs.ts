import { Command, InvalidArgumentError } from 'commander';
import * as path from 'node:path';
import {
  acceptHarmonyOsEmulatorLicenses,
  createHarmonyOsEmulatorDevice,
  deleteHarmonyOsEmulatorDevice,
  harmonyOsEmulatorAddress,
  HARMONYOS_EMULATOR_BOOT_MODES,
  HARMONYOS_EMULATOR_HDC_PORTS,
  installHarmonyOsEmulatorImage,
  listHarmonyOsEmulatorDevices,
  listHarmonyOsEmulatorImages,
  readHarmonyOsEmulatorLicenses,
  requireHarmonyOsEmulator,
  resolveHarmonyOsEmulatorImage,
  reviewHarmonyOsEmulatorLicenses,
  startHarmonyOsEmulator,
  stopHarmonyOsEmulator,
  type HarmonyOsEmulatorBootMode,
  type HarmonyOsEmulatorDevice,
  type HarmonyOsEmulatorImage,
  type HarmonyOsEmulatorLicenses,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

function parseSeconds(v: string): number {
  if (!/^\d+$/.test(v)) throw new InvalidArgumentError('expected a whole number of seconds.');
  return Number(v);
}

function parseGb(min: number, max: number) {
  return (v: string): number => {
    const n = Number(v);
    if (!/^\d+$/.test(v) || n < min || n > max) throw new InvalidArgumentError(`expected a whole number of GB from ${min} to ${max}.`);
    return n;
  };
}

function parseHdcPort(v: string): number {
  const n = Number(v);
  const { min, max } = HARMONYOS_EMULATOR_HDC_PORTS;
  if (!/^\d+$/.test(v) || n < min || n > max) throw new InvalidArgumentError(`expected a port from ${min} to ${max}.`);
  return n;
}

function parseBootMode(v: string): HarmonyOsEmulatorBootMode {
  if (!(HARMONYOS_EMULATOR_BOOT_MODES as readonly string[]).includes(v)) {
    throw new InvalidArgumentError(`expected one of ${HARMONYOS_EMULATOR_BOOT_MODES.join(', ')}.`);
  }
  return v as HarmonyOsEmulatorBootMode;
}

/** One `emulator harmonyos list` line. */
export function formatHarmonyOsDeviceRow(d: HarmonyOsEmulatorDevice): string {
  return [
    d.name,
    d.running ? 'running' : 'stopped',
    d.osVersion ?? '?',
    d.deviceType ?? '?',
    `hdc=${harmonyOsEmulatorAddress(d)}`,
  ].join('\t');
}

/** One `emulator harmonyos images` line: `*` marks a downloaded image, `^` a newer build of one. */
export function formatHarmonyOsImageRow(i: HarmonyOsEmulatorImage): string {
  const mark = i.downloaded ? (i.upgradable ? '^' : '*') : ' ';
  return `${mark}  ${i.osVersion.padEnd(26)} ${i.deviceType.padEnd(14)} ${i.softwareVersion ?? ''}`.trimEnd();
}

/** What `emulator harmonyos license` prints. */
export function formatHarmonyOsLicenses(lic: HarmonyOsEmulatorLicenses): string {
  if (lic.agreements.length === 0) return 'The HarmonyOS emulator ships no agreements.';
  const state = (accepted: boolean | undefined) => (accepted === undefined ? 'unknown' : accepted ? 'accepted' : 'not accepted');
  const rows = lic.agreements.map((a) => `${state(a.accepted).padEnd(13)} ${a.title}\n${' '.repeat(14)}${a.file}`);
  const pending = lic.agreements.some((a) => a.accepted !== true);
  return (
    rows.join('\n') +
    (pending
      ? '\n\nRead them, then accept with `oniro-app emulator harmonyos license --accept`, or go through ' +
        "Huawei's own prompt with `oniro-app emulator harmonyos license --review`."
      : '')
  );
}

/** Register `emulator harmonyos …` on the `emulator` command. */
export function registerHarmonyOsEmulatorCommands(emu: Command): void {
  const hos = emu
    .command('harmonyos')
    .description(
      "Manage Huawei's HarmonyOS emulator (`Emulator`, shipped in `emulator/` of the HarmonyOS command-line tools " +
        '26.0.0 or later, on Linux): its images, and the devices that run them. Found at ONIRO_HARMONYOS_EMULATOR_PATH, ' +
        'else in the command-line tools at ONIRO_CMD_TOOLS_PATH, else next to the HarmonyOS SDK.',
    );

  hos
    .command('list')
    .description('List the devices: name, running or stopped, image, device type and hdc address.')
    .option('--json', 'Print the devices as JSON.')
    .action(async (opts: { json?: boolean }) => {
      const { config, logger } = getRuntime();
      const devices = await listHarmonyOsEmulatorDevices(requireHarmonyOsEmulator(config, logger), { logger });
      if (opts.json) process.stdout.write(`${JSON.stringify(devices, null, 2)}\n`);
      else if (devices.length === 0) logger.info('No devices; create one with `oniro-app emulator harmonyos create`.');
      else process.stdout.write(`${devices.map(formatHarmonyOsDeviceRow).join('\n')}\n`);
    });

  hos
    .command('images')
    .description(
      "List the images in Huawei's catalogue (fetched over the network): `*` marks a downloaded one, `^` one with a newer build.",
    )
    .option('--device-type <type>', 'Only this device type (phone, foldable, tablet, 2in1, wearable, …).')
    .option('--downloaded', 'Only the downloaded images (needs no network).')
    .option('--http-proxy <url>', 'Proxy for the catalogue request.')
    .option('--json', 'Print the images as JSON.')
    .action(async (opts: { deviceType?: string; downloaded?: boolean; httpProxy?: string; json?: boolean }) => {
      const { config, logger } = getRuntime();
      const images = await listHarmonyOsEmulatorImages(requireHarmonyOsEmulator(config, logger), { ...opts, logger });
      if (opts.json) process.stdout.write(`${JSON.stringify(images, null, 2)}\n`);
      else if (images.length === 0) logger.info('No images match.');
      else process.stdout.write(`${images.map(formatHarmonyOsImageRow).join('\n')}\n`);
    });

  hos
    .command('install <image>')
    .description(
      "Download an image from Huawei's servers. <image> is the API level (26), the release (7.0.0) or the name " +
        '`images` lists ("HarmonyOS 7.0.0(26.0.0)"). Needs the HarmonyOS SDK License Agreement accepted (see `license`).',
    )
    .option('--device-type <type>', 'Device type of the image.', 'phone')
    .option('--image-root <dir>', "Where to put it (default: the emulator's image root).")
    .option('--http-proxy <url>', 'Proxy for the download.')
    .action(async (query: string, opts: { deviceType: string; imageRoot?: string; httpProxy?: string }) => {
      const { config, logger, progress } = getRuntime();
      const emulator = requireHarmonyOsEmulator(config, logger);
      const catalogue = await listHarmonyOsEmulatorImages(emulator, { deviceType: opts.deviceType, httpProxy: opts.httpProxy, logger });
      const image = resolveHarmonyOsEmulatorImage(catalogue, query, opts.deviceType);
      if (image.downloaded && !image.upgradable) {
        logger.info(`${image.osVersion} (${image.deviceType}) is already downloaded.`);
        return;
      }
      logger.info(`Downloading ${image.osVersion} (${image.deviceType}, build ${image.softwareVersion ?? '?'})...`);
      await installHarmonyOsEmulatorImage({
        emulator,
        image,
        imageRoot: opts.imageRoot ? path.resolve(opts.imageRoot) : undefined,
        httpProxy: opts.httpProxy,
        progress,
        logger,
      });
      logger.info(`Downloaded ${image.osVersion} (${image.deviceType}). Create a device on it with \`oniro-app emulator harmonyos create <name> --image ${image.api ?? query}\`.`);
    });

  hos
    .command('create <name>')
    .description(
      'Create a device on a downloaded image. <name>: letters, digits, underscores and spaces. Huawei picks a ' +
        'default model and screen for the device type.',
    )
    .requiredOption('--image <image>', 'The image: API level (26), release (7.0.0) or full name ("HarmonyOS 7.0.0(26.0.0)").')
    .option('--device-type <type>', 'Device type.', 'phone')
    .option('--memory <GB>', 'Guest RAM in GB (2-32; default 4).', parseGb(2, 32))
    .option('--storage <GB>', 'Data partition in GB (2-1023; default 6).', parseGb(2, 1023))
    .option('--json', 'Print the created device as JSON.')
    .action(async (name: string, opts: { image: string; deviceType: string; memory?: number; storage?: number; json?: boolean }) => {
      const { config, logger } = getRuntime();
      const emulator = requireHarmonyOsEmulator(config, logger);
      const downloaded = await listHarmonyOsEmulatorImages(emulator, { deviceType: opts.deviceType, downloaded: true, logger });
      let image: HarmonyOsEmulatorImage;
      try {
        image = resolveHarmonyOsEmulatorImage(downloaded, opts.image, opts.deviceType);
      } catch (err) {
        throw new Error(
          `${(err as Error).message.replace(/^No HarmonyOS/, 'No downloaded HarmonyOS')} ` +
            `Download it with \`oniro-app emulator harmonyos install ${JSON.stringify(opts.image)} --device-type ${JSON.stringify(opts.deviceType)}\`.`,
        );
      }
      const device = await createHarmonyOsEmulatorDevice({
        emulator,
        name,
        image,
        memoryGb: opts.memory,
        storageGb: opts.storage,
        logger,
      });
      if (opts.json) process.stdout.write(`${JSON.stringify(device, null, 2)}\n`);
      else logger.info(`Created "${device.name}" (${device.osVersion ?? image.osVersion}, ${device.deviceType ?? image.deviceType}). Start it with \`oniro-app emulator harmonyos start ${JSON.stringify(name)}\`.`);
    });

  hos
    .command('start <name>')
    .description(
      'Start a device in the background, so the CLI can exit while it runs; the emulator connects it to the hdc ' +
        'server. Sets __GL_SYNC_TO_VBLANK=0 unless set (NVIDIA vsync stalls its frames). Needs the HarmonyOS ' +
        'Software License and Service Agreement accepted (see `license`).',
    )
    .option('--headless', 'No window (-noWindow).')
    .option('--boot-mode <mode>', `${HARMONYOS_EMULATOR_BOOT_MODES.join(', ')} (default: cold boot, or quick boot when the device enables it).`, parseBootMode)
    .option('--hdc-port <port>', `hdc port for this run (${HARMONYOS_EMULATOR_HDC_PORTS.min}-${HARMONYOS_EMULATOR_HDC_PORTS.max}; default: the device's, else 5555).`, parseHdcPort)
    .option('--log <path>', "The emulator's output (default: <device>/Log/oniro-app-start.log).")
    .option('--wait-ready <seconds>', 'Wait up to N seconds until the guest reports bootevent.boot.completed=true.', parseSeconds)
    .option('--json', 'Print the result as JSON: name, address, pid, logFile, alreadyRunning, ready, bootSeconds.')
    .action(
      async (
        name: string,
        opts: { headless?: boolean; bootMode?: HarmonyOsEmulatorBootMode; hdcPort?: number; log?: string; waitReady?: number; json?: boolean },
      ) => {
        const { config, logger } = getRuntime();
        const started = await startHarmonyOsEmulator({
          config,
          emulator: requireHarmonyOsEmulator(config, logger),
          name,
          headless: opts.headless,
          bootMode: opts.bootMode,
          hdcPort: opts.hdcPort,
          logFile: opts.log ? path.resolve(opts.log) : undefined,
          waitReadySeconds: opts.waitReady,
          logger,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(started, null, 2)}\n`);
          return;
        }
        logger.info(
          `"${name}" ${started.ready ? 'is ready' : started.alreadyRunning ? 'is running' : 'is booting'} at ${started.address}. ` +
            `With other devices connected, target it with ONIRO_DEVICE_SERIAL=${started.address}.`,
        );
      },
    );

  hos
    .command('stop <name>')
    .description('Stop a device and wait until it has shut down.')
    .option('--timeout <seconds>', 'How long to wait for it to shut down (default 60).', parseSeconds)
    .action(async (name: string, opts: { timeout?: number }) => {
      const { config, logger } = getRuntime();
      const stopped = await stopHarmonyOsEmulator({ emulator: requireHarmonyOsEmulator(config, logger), name, waitSeconds: opts.timeout, logger });
      logger.info(stopped ? `Stopped "${name}".` : `"${name}" was not running.`);
    });

  hos
    .command('delete <name>')
    .description("Delete a stopped device and its data. The image stays.")
    .action(async (name: string) => {
      const { config, logger } = getRuntime();
      await deleteHarmonyOsEmulatorDevice({ emulator: requireHarmonyOsEmulator(config, logger), name, logger });
      logger.info(`Deleted "${name}".`);
    });

  hos
    .command('license')
    .description(
      "Show Huawei's agreements the emulator needs (the HarmonyOS SDK License Agreement to download images, the " +
        'Software License and Service Agreement to start devices), whether each is accepted, and where to read them. ' +
        'Exits 1 while one is not accepted.',
    )
    .option('--accept', 'Accept all of them (Emulator -license accept). Read them first.')
    .option('--review', "Go through Huawei's own prompt on this terminal, agreement by agreement (Emulator -license).")
    .option('--json', 'Print the agreements as JSON: agreements (name, title, file, accepted), stateFile.')
    .action(async (opts: { accept?: boolean; review?: boolean; json?: boolean }) => {
      const { config, logger } = getRuntime();
      if (opts.accept && opts.review) throw new Error('Pass either --accept or --review, not both.');
      const emulator = requireHarmonyOsEmulator(config, logger);
      if (opts.accept) {
        await acceptHarmonyOsEmulatorLicenses(emulator, { logger });
        logger.info("Accepted Huawei's agreements for the HarmonyOS emulator.");
      } else if (opts.review) {
        if (!process.stdin.isTTY) throw new Error('--review needs a terminal; read the agreements and pass --accept instead.');
        await reviewHarmonyOsEmulatorLicenses(emulator);
      }
      const licenses = readHarmonyOsEmulatorLicenses(emulator);
      process.stdout.write(opts.json ? `${JSON.stringify(licenses, null, 2)}\n` : `${formatHarmonyOsLicenses(licenses)}\n`);
      if (licenses.agreements.some((a) => a.accepted === false)) process.exitCode = 1;
    });
}
