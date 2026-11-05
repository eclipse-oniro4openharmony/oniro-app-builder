import { Command, InvalidArgumentError } from 'commander';
import {
  MAX_POOL_INSTANCE,
  POOL_DEFAULT_MEMORY,
  POOL_DEFAULT_RESOLUTION,
  POOL_DEFAULT_SMP,
  DEFAULT_BOOT_TIMEOUT_SECONDS,
  attemptHdcConnection,
  getEmulatorStatus,
  getPoolInstanceStatus,
  installEmulator,
  isEmulatorInstalled,
  removeEmulator,
  startEmulator,
  startPoolInstance,
  stopEmulator,
  stopPoolInstance,
  type EmulatorAccel,
  type EmulatorInstanceStatus,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

function parseInstance(v: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(v) || n > MAX_POOL_INSTANCE) {
    throw new InvalidArgumentError(`expected an integer from 0 to ${MAX_POOL_INSTANCE}.`);
  }
  return n;
}

function parseSeconds(v: string): number {
  if (!/^\d+$/.test(v)) throw new InvalidArgumentError('expected a whole number of seconds.');
  return Number(v);
}

function parseSmp(v: string): number {
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new InvalidArgumentError('expected a positive integer.');
  return Number(v);
}

const ACCELS: readonly EmulatorAccel[] = ['auto', 'kvm', 'hvf', 'whpx', 'tcg'];

function parseAccel(v: string): EmulatorAccel {
  if (!(ACCELS as readonly string[]).includes(v)) throw new InvalidArgumentError(`expected one of ${ACCELS.join(', ')}.`);
  return v as EmulatorAccel;
}

/** One `emulator status` line: instance, health, ports, then what is known about the process. */
export function formatInstanceRow(i: EmulatorInstanceStatus): string {
  const fields = [String(i.instance), i.state, `hdc=${i.address}`];
  if (i.vncPort) fields.push(`vnc=127.0.0.1:${i.vncPort}`);
  if (i.instance > 0 && i.serialPort) fields.push(`serial=127.0.0.1:${i.serialPort}`);
  if (i.pid) fields.push(`pid=${i.pid}`);
  if (i.smp) fields.push(`cpus=${i.smp}`);
  if (i.memory) fields.push(`mem=${i.memory}`);
  if (i.bootSeconds !== undefined) fields.push(`boot=${i.bootSeconds}s`);
  return fields.join('\t');
}

/** Options `emulator start` accepts only for a pool instance (keys as commander names them). */
const POOL_ONLY_OPTIONS = ['memory', 'smp', 'resolution', 'window', 'fresh', 'bootTimeout', 'qemu', 'accel', 'json'] as const;

interface StartOpts {
  headless?: boolean;
  log?: string;
  waitForHdc: number;
  connect?: string;
  instance?: number;
  memory?: string;
  smp?: number;
  resolution?: string;
  window?: boolean;
  fresh?: boolean;
  waitReady?: number;
  bootTimeout?: number;
  qemu?: string;
  accel?: EmulatorAccel;
  json?: boolean;
}

const flagName = (key: string): string => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export function registerEmulatorCommand(program: Command): void {
  const emu = program.command('emulator').description('Manage the Oniro emulator.');

  emu
    .command('install')
    .description('Download and install the Oniro emulator (QEMU-based). Skips if already installed.')
    .option('--force', 'Reinstall even if the emulator is already present.')
    .option(
      '--tmp-dir <path>',
      'Directory for the downloaded ZIP (default: ONIRO_TMP_DIR, else .oniro-tmp next to the ' +
        'install target). Use this when that filesystem is short on space.',
    )
    .action(async (opts: { force?: boolean; tmpDir?: string }) => {
      const { config, logger, progress } = getRuntime();
      if (isEmulatorInstalled(config) && !opts.force) {
        logger.info('Emulator already installed; pass --force to reinstall.');
        return;
      }
      logger.info('Installing Oniro emulator...');
      await installEmulator({ config, progress, logger, tmpDir: opts.tmpDir });
      logger.info('Emulator installed.');
    });

  emu
    .command('start')
    .description(
      'Start the Oniro emulator and detach, so the CLI can exit while it keeps running. Without --instance (or ' +
        'with --instance 0) it runs the bundled launcher (run.sh / run.bat). --instance <n> (1..99) starts pool ' +
        'instance n instead: its own QEMU on copy-on-write overlays of the images, hdc on 127.0.0.1:55555+n, ' +
        'headless VNC on 127.0.0.1:5900+n, serial console on telnet 127.0.0.1:4444+n.',
    )
    .option('--instance <n>', 'Pool instance number (1..99). 0 or unset: the default emulator via run.sh.', parseInstance)
    .option('--headless', 'Launch headless (VNC + telnet serial, no local window). Required in CI. Pool instances are headless unless --window.')
    .option('--log <path>', 'Redirect launcher stdout/stderr to this file. Defaults to discarding output (pool instances: <instance dir>/qemu.log).')
    .option('--wait-for-hdc <seconds>', 'Default emulator: wait up to N seconds for hdc to connect (restarts the hdc server). 0 = do not wait.', (v) => parseInt(v, 10), 0)
    .option('--wait-ready <seconds>', 'Wait up to N seconds until the guest reports bootevent.boot.completed=true. Connects with hdc tconn only, never restarting the hdc server.', parseSeconds)
    .option('--connect <host:port>', 'Default emulator: override the launcher\'s hdc port-forward bind address. Pass 0.0.0.0:55555 on hosts where QEMU refuses to bind 127.0.0.1 (some CI runners).')
    .option('--memory <size>', `Pool: guest RAM in QEMU syntax (default ${POOL_DEFAULT_MEMORY}).`)
    .option('--smp <n>', `Pool: virtual CPUs (default ${POOL_DEFAULT_SMP}).`, parseSmp)
    .option('--resolution <WxH>', `Pool: display resolution (default ${POOL_DEFAULT_RESOLUTION}).`)
    .option('--window', 'Pool: show a local SDL window instead of VNC.')
    .option('--fresh', 'Pool: discard the instance\'s overlays first (factory reset).')
    .option('--boot-timeout <seconds>', `Pool: seconds after launch past which a boot that has not completed is reported stuck (default ${DEFAULT_BOOT_TIMEOUT_SECONDS}).`, parseSeconds)
    .option('--qemu <path>', 'Pool: qemu-system-x86_64 binary (default QEMU_BIN, else PATH); qemu-img is looked up next to it.')
    .option('--accel <kind>', `Pool: accelerator, one of ${ACCELS.join(', ')} (default auto: KVM on Linux, as run.sh).`, parseAccel)
    .option('--json', 'Pool: print the instance\'s status as JSON when done.')
    .action(async (opts: StartOpts) => {
      const { config, logger } = getRuntime();
      if (opts.instance === undefined || opts.instance === 0) {
        const poolOnly = POOL_ONLY_OPTIONS.filter((k) => opts[k] !== undefined);
        if (poolOnly.length > 0) {
          throw new InvalidArgumentError(
            `${poolOnly.map(flagName).join(', ')} ${poolOnly.length > 1 ? 'apply' : 'applies'} only to pool instances ` +
              `(--instance 1..${MAX_POOL_INSTANCE}).`,
          );
        }
        await startEmulator({
          config,
          logger,
          headless: opts.headless === true,
          logFile: opts.log,
          waitForHdcSeconds: opts.waitForHdc,
          waitReadySeconds: opts.waitReady,
          connect: opts.connect,
        });
        logger.info('Emulator start command complete.');
        return;
      }
      if (opts.connect || opts.waitForHdc > 0) {
        throw new InvalidArgumentError(
          '--connect and --wait-for-hdc apply to the default emulator only; a pool instance listens on 127.0.0.1:55555+n, wait with --wait-ready.',
        );
      }
      const status = await startPoolInstance({
        config,
        logger,
        instance: opts.instance,
        memory: opts.memory,
        smp: opts.smp,
        resolution: opts.resolution,
        headless: opts.window !== true,
        fresh: opts.fresh === true,
        waitReadySeconds: opts.waitReady,
        bootTimeoutSeconds: opts.bootTimeout,
        qemuBin: opts.qemu,
        accel: opts.accel,
        logFile: opts.log,
      });
      if (opts.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else logger.info(`Instance ${status.instance}: ${status.state} (${status.address}).`);
    });

  emu
    .command('status')
    .description(
      'Report whether the Oniro emulator is installed, running, and connected to hdc, without starting it, and ' +
        'list every instance (the default emulator as 0, then each pool instance) with its health: stopped, ' +
        'booting, ready, hdc-lost or stuck. Exits 1 when the emulator is not installed.',
    )
    .option('--address <addr>', 'hdc address the default emulator listens on', '127.0.0.1:55555')
    .option('--instance <n>', 'Report only this instance (0 = the default emulator).', parseInstance)
    .option('--json', 'Emit machine-readable JSON: `instances` lists every instance; with --instance, that instance alone.')
    .action(async (opts: { address: string; json?: boolean; instance?: number }) => {
      const { config, logger } = getRuntime();
      const print = (one: EmulatorInstanceStatus): void => {
        process.stdout.write(opts.json ? `${JSON.stringify(one, null, 2)}\n` : `${formatInstanceRow(one)}\n`);
      };
      if (opts.instance !== undefined && opts.instance > 0) {
        print(await getPoolInstanceStatus(config, opts.instance, { logger }));
        if (!isEmulatorInstalled(config)) process.exitCode = 1;
        return;
      }
      const status = await getEmulatorStatus(config, { address: opts.address, logger });
      if (opts.instance === 0) {
        print(status.instances[0]!);
      } else if (opts.json) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      } else {
        process.stdout.write(
          `installed: ${status.installed ? 'yes' : 'no'} (${status.dir})\n` +
            `running:   ${status.running ? 'yes' : 'no'}\n` +
            `connected: ${status.connected ? 'yes' : 'no'} (${status.address})\n`,
        );
        if (status.instances.length > 1) {
          process.stdout.write(`instances:\n${status.instances.map((i) => `  ${formatInstanceRow(i)}`).join('\n')}\n`);
        }
      }
      if (!status.installed) process.exitCode = 1;
    });

  emu
    .command('stop')
    .description(
      'Without --instance: kill running emulator processes (every qemu-system-x86_64, pool instances included). ' +
        'With --instance <n>: stop only that pool instance\'s QEMU and drop its target from hdc.',
    )
    .option('--instance <n>', 'Pool instance to stop (1..99).', parseInstance)
    .option('--discard', 'With --instance: also delete the instance\'s overlays, log and state.')
    .action(async (opts: { instance?: number; discard?: boolean }) => {
      const { config, logger } = getRuntime();
      if (opts.instance === undefined || opts.instance === 0) {
        if (opts.discard) throw new InvalidArgumentError(`--discard needs --instance <n> (1..${MAX_POOL_INSTANCE}).`);
        await stopEmulator(logger);
        logger.info('Emulator stopped.');
        return;
      }
      const stopped = await stopPoolInstance({ config, instance: opts.instance, discard: opts.discard === true, logger });
      if (!stopped) logger.info(`Instance ${opts.instance} was not running.`);
    });

  emu
    .command('connect')
    .description('Attempt to connect hdc to the emulator.')
    .option('--address <addr>', 'hdc address to connect to', '127.0.0.1:55555')
    .action(async (opts: { address: string }) => {
      const { config, logger } = getRuntime();
      const ok = await attemptHdcConnection(config, opts.address, logger);
      if (!ok) {
        logger.error(`Could not connect hdc to ${opts.address}.`);
        process.exit(1);
      }
      logger.info(`hdc connected to ${opts.address}.`);
    });

  emu
    .command('remove')
    .description('Delete the configured emulator directory.')
    .action(() => {
      const { config, logger } = getRuntime();
      removeEmulator(config);
      logger.info('Emulator removed.');
    });
}
