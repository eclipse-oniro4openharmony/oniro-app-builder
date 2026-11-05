import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OniroError } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { McpServer, serveStdio } from '../mcp/protocol.js';
import { TOOL_NAMES, selectTools, type ToolContext } from '../mcp/tools.js';

interface ServeMcpOpts {
  project?: string;
  device?: string;
  tools?: string;
  readOnly?: boolean;
}

/** The comma list of `--tools`, trimmed, without empties; undefined when not given. */
export function parseToolList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) throw new OniroError('--tools needs at least one tool name.');
  return names;
}

function instructions(ctx: ToolContext, toolCount: number): string {
  return (
    `oniro-app: build, check, test, deploy and inspect the OpenHarmony/HarmonyOS app in ${ctx.projectDir}` +
    `${ctx.deviceSerial ? ` on device ${ctx.deviceSerial}` : ''} (${toolCount} tools). Each tool runs the matching ` +
    '`oniro-app` command and returns its `--json` object, as structured content and as JSON text; isError is true ' +
    'when the command would exit non-zero (a failed build, check, test or smoke check, a missing symbol) or could not ' +
    'run. Relative paths resolve against the project. A typical round: check_arkts on the changed files, build, ' +
    'apply with smoke, then screenshot and dump_layout (flat) to see the result, input to drive it, logs_crash when it died.'
  );
}

export function registerServeCommand(program: Command): void {
  const serve = program.command('serve').description('Serve oniro-app to other programs.');

  serve
    .command('mcp')
    .description(
      'A Model Context Protocol server on stdio (newline-delimited JSON-RPC 2.0) exposing the gate commands as typed ' +
        `tools for agents: ${TOOL_NAMES.join(', ')}. Each tool returns the JSON the command's --json prints. ` +
        'stdout carries only the protocol; logs go to stderr. Register it with Claude Code: ' +
        '`claude mcp add oniro-app -- oniro-app serve mcp --project <dir>`.',
    )
    .allowExcessArguments(false)
    .option('--project <dir>', 'Project the tools work on unless a call names another (default: the current directory).')
    .option('--device <serial>', 'Device the tools target unless a call names another (default: the only connected one).')
    .option('--tools <list>', `Expose only these tools, comma-separated (of ${TOOL_NAMES.join(', ')}).`)
    .option('--read-only', 'Leave out the tools that change the device: apply, launch, input, test.')
    .action(async (opts: ServeMcpOpts) => {
      const { logger } = getRuntime();
      const projectDir = path.resolve(opts.project ?? process.cwd());
      if (!fs.existsSync(projectDir)) throw new OniroError(`--project ${projectDir} does not exist.`);
      const tools = selectTools(parseToolList(opts.tools), !!opts.readOnly);
      if (!tools.length) throw new OniroError('No tool left to serve: --read-only removed every tool --tools named.');
      const context: ToolContext = { projectDir, deviceSerial: opts.device };
      const server = new McpServer({
        name: 'oniro-app',
        version: program.version() ?? '0.0.0',
        tools,
        context,
        instructions: instructions(context, tools.length),
        logger,
      });

      // stdout is the protocol. Anything else that writes to it (a stray
      // console.log in a dependency) goes to stderr instead of corrupting it.
      const protocolWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
        (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
      // The client went away: nothing left to answer.
      process.stdout.on('error', () => process.exit(0));

      logger.info(`oniro-app MCP server on stdio: project ${projectDir}, tools ${tools.map((t) => t.name).join(', ')}`);
      await serveStdio(server, { write: (line) => void protocolWrite(line) });
      logger.info('stdin closed; MCP server exiting.');
      // A device helper left running (an hdc child, a timer) must not keep the
      // process alive; exit once the last response is flushed.
      protocolWrite('', () => process.exit(0));
    });
}
