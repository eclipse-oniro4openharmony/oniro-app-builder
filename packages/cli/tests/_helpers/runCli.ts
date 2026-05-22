import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'oniro-app.js',
);

export interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Spawn the built CLI binary with the given args. Captures stdout/stderr/exit code.
 * Pre-test build is wired via the package's `pretest` script, so this assumes
 * `dist/oniro-app.js` exists.
 */
export function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result: SpawnSyncReturns<string> = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}
