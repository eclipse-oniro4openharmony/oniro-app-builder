import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDoctor, type DoctorCheck, type DoctorReport } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface DoctorOpts {
  json?: boolean;
  fix?: boolean;
  device: boolean;
  serial?: string;
  arktsCheck: boolean;
}

/** One line per check, `fail  sdk         API 20 is not installed at …`, then its fix indented. */
export function formatDoctorCheck(c: DoctorCheck): string {
  const line = `${c.status.padEnd(5)} ${c.id.padEnd(16)} ${c.detail}${c.fixed ? ' (fixed)' : ''}`;
  return c.fix && c.status !== 'ok' && c.status !== 'skip' ? `${line}\n${' '.repeat(23)}fix: ${c.fix}` : line;
}

export function doctorExitCode(report: Pick<DoctorReport, 'ok'>): number {
  return report.ok ? 0 : 1;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor [project-dir]')
    .description(
      'Check that this machine can build, check, sign, install and test: node, java, the SDK the project compiles ' +
        'with, the command-line tools (complete, their version, their flavour against runtimeOS), a `check arkts` ' +
        "self-test, hdc and a reachable device at the project's API, signing material, free disk space. Each check is " +
        'ok, warn, fail or skip, with a fix. Uses the project in the current directory when there is one. Exits 1 when ' +
        'any check fails.',
    )
    .option('--json', 'Print the report as JSON: ok, checks (id, status, detail, fix, fixed), project, versions.')
    .option('--fix', "Install the project's missing OpenHarmony SDK.")
    .option('--no-device', 'Skip the device check (for a machine that only builds).')
    .option('--serial <serial>', 'The device to check, when several are connected.')
    .option('--no-arkts-check', 'Skip the `check arkts` self-test.')
    .action(async (projectDir: string | undefined, opts: DoctorOpts) => {
      const { config, logger, progress } = getRuntime();
      let dir: string | undefined;
      if (projectDir) {
        dir = path.resolve(projectDir);
      } else if (fs.existsSync(path.join(process.cwd(), 'build-profile.json5'))) {
        dir = process.cwd();
      }
      const report = await runDoctor({
        config,
        projectDir: dir,
        fix: opts.fix,
        device: opts.device,
        deviceSerial: opts.serial,
        arktsSelfTest: opts.arktsCheck,
        logger,
        progress,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        if (report.project) process.stdout.write(`Project ${report.project.dir} (${report.project.runtimeOS})\n`);
        for (const c of report.checks) process.stdout.write(`${formatDoctorCheck(c)}\n`);
        const failed = report.checks.filter((c) => c.status === 'fail').length;
        process.stdout.write(failed ? `${failed} check(s) failed.\n` : 'No check failed.\n');
      }
      process.exitCode = doctorExitCode(report);
    });
}
