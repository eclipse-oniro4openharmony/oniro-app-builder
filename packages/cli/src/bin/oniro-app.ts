import { Command } from 'commander';
import { OniroError } from '@oniroproject/core';
import { registerSdkCommand } from '../commands/sdk.js';
import { registerCmdToolsCommand } from '../commands/cmdtools.js';
import { registerEmulatorCommand } from '../commands/emulator.js';
import { registerBuildCommand } from '../commands/build.js';
import { registerSignCommand } from '../commands/sign.js';
import { registerAppCommand } from '../commands/app.js';
import { registerCreateCommand } from '../commands/create.js';
import { registerTemplatesCommand } from '../commands/templates.js';

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
    .showHelpAfterError();

  registerSdkCommand(program);
  registerCmdToolsCommand(program);
  registerEmulatorCommand(program);
  registerBuildCommand(program);
  registerSignCommand(program);
  registerAppCommand(program);
  registerCreateCommand(program);
  registerTemplatesCommand(program);

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
