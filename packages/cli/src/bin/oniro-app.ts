import { Command } from 'commander';
import { OniroError } from '@oniroproject/core';
import { registerSdkCommand } from '../commands/sdk.js';
import { registerCmdToolsCommand } from '../commands/cmdtools.js';
import { registerEmulatorCommand } from '../commands/emulator.js';
import { registerBuildCommand } from '../commands/build.js';
import { registerSignCommand } from '../commands/sign.js';
import { registerAuthCommand } from '../commands/auth.js';
import { registerAppCommand } from '../commands/app.js';
import { registerCreateCommand } from '../commands/create.js';
import { registerTemplatesCommand } from '../commands/templates.js';
import { registerRebootCommand } from '../commands/reboot.js';
import { registerWaitCommand } from '../commands/wait.js';
import { registerWatchCommand } from '../commands/watch.js';
import { registerScreenshotCommand } from '../commands/screenshot.js';
import { registerDumpCommand } from '../commands/dump.js';
import { registerDevicesCommand } from '../commands/devices.js';
import { registerFileCommand } from '../commands/file.js';
import { registerLintCommand } from '../commands/lint.js';
import { registerTestCommand } from '../commands/test.js';
import { registerCheckCommand } from '../commands/check.js';
import { registerDoctorCommand } from '../commands/doctor.js';
import { registerScreensCommand } from '../commands/screens.js';
import { registerInputCommand } from '../commands/input.js';
import { registerLogsCommand } from '../commands/logs.js';
import { registerHdcCommand } from '../commands/hdc.js';
import { registerApiCommand } from '../commands/api.js';
import { registerServeCommand } from '../commands/serve.js';

declare const __CLI_VERSION__: string;
const CLI_VERSION = __CLI_VERSION__;

function buildProgram(): Command {
  const program = new Command()
    .name('oniro-app')
    .description(
      'Cross-platform CLI for Oniro/OpenHarmony app development.\n\n' +
        'Designed for non-interactive use (CI, scripts, agents): every command\n' +
        'takes explicit flags, results go to stdout, progress/logs go to stderr,\n' +
        'and a non-zero exit code indicates failure.',
    )
    .version(CLI_VERSION)
    .showHelpAfterError()
    // Lets `hdc` pass its arguments through untouched; global options go before the command.
    .enablePositionalOptions();

  registerSdkCommand(program);
  registerCmdToolsCommand(program);
  registerEmulatorCommand(program);
  registerBuildCommand(program);
  registerSignCommand(program);
  registerAuthCommand(program);
  registerAppCommand(program);
  registerCreateCommand(program);
  registerTemplatesCommand(program);
  registerRebootCommand(program);
  registerWaitCommand(program);
  registerWatchCommand(program);
  registerScreenshotCommand(program);
  registerDumpCommand(program);
  registerDevicesCommand(program);
  registerFileCommand(program);
  registerLintCommand(program);
  registerCheckCommand(program);
  registerDoctorCommand(program);
  registerScreensCommand(program);
  registerApiCommand(program);
  registerTestCommand(program);
  registerInputCommand(program);
  registerLogsCommand(program);
  registerHdcCommand(program);
  registerServeCommand(program);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const message = err instanceof OniroError ? err.message : err instanceof Error ? err.message : String(err);
    process.stderr.write(`[error] ${message}\n`);
    if (process.env.ONIRO_DEBUG === '1' && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  }
}

void main();
