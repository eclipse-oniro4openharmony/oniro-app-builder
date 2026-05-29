import { Command } from 'commander';
import { listDevices } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

export function registerDevicesCommand(program: Command): void {
  program
    .command('devices')
    .description('List connected hdc devices.')
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (opts: { json?: boolean }) => {
      const { config } = getRuntime();
      const devices = await listDevices(config);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(devices, null, 2)}\n`);
        return;
      }
      if (devices.length === 0) {
        process.stdout.write('(no devices)\n');
        return;
      }
      for (const d of devices) {
        process.stdout.write(`${d.serial}\t${d.connection ?? ''}\t${d.status}\n`);
      }
    });
}
