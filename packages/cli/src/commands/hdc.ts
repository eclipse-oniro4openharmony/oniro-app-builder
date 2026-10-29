import { Command } from 'commander';
import { getHdcPath, hdcTargetArgsFor, spawnCompat } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

/** The argv for the passthrough: verbatim when the caller already picked a target with `-t`. */
export function hdcPassthroughArgv(args: readonly string[], device?: string): string[] {
  return args[0] === '-t' ? [...args] : [...hdcTargetArgsFor(args, device), ...args];
}

export function registerHdcCommand(program: Command): void {
  program
    .command('hdc')
    .description(
      'Run the hdc binary oniro-app itself uses (see `cmdtools status`), addressed at --device or ' +
        'ONIRO_DEVICE_SERIAL, with stdio passed through. Exits with hdc\'s own code, which is 0 even for ' +
        'a `[Fail]` line. Example: oniro-app hdc shell param get const.ohos.apiversion',
    )
    .argument('[args...]', 'hdc arguments, passed through verbatim')
    .option('--device <serial>', 'Target device serial.')
    .option('--path', 'Print the hdc binary path and exit.')
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (args: string[], opts: { device?: string; path?: boolean }) => {
      const { config } = getRuntime();
      const hdc = getHdcPath(config);
      if (opts.path) {
        process.stdout.write(`${hdc}\n`);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawnCompat(hdc, hdcPassthroughArgv(args, opts.device), { stdio: 'inherit' });
        child.on('error', (err) => reject(new Error(`Failed to run ${hdc}: ${err.message}`)));
        child.on('close', (code) => {
          process.exitCode = code ?? 1;
          resolve();
        });
      });
    });
}
