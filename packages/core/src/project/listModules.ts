import * as fs from 'node:fs';
import * as path from 'node:path';
import { OniroError } from '../ports/errors.js';
import { readJson5File } from './jsonHelpers.js';

export interface ProjectModule {
  name: string;
  /** Source path relative to the project root (e.g. `./entry`). */
  srcPath: string;
  /** Target names declared under the module (often empty). */
  targets: string[];
}

interface BuildProfile {
  modules?: Array<{ name?: string; srcPath?: string; targets?: Array<{ name?: string }> }>;
}

/**
 * Read the `modules[]` declared in `build-profile.json5` so callers can target a
 * specific module in a multi-module project.
 */
export function listModules(opts: { projectDir: string }): ProjectModule[] {
  const buildProfile = path.join(opts.projectDir, 'build-profile.json5');
  if (!fs.existsSync(buildProfile)) {
    throw new OniroError(`build-profile.json5 not found at ${buildProfile}`);
  }
  const parsed = readJson5File<BuildProfile>(buildProfile);
  return (parsed.modules ?? [])
    .filter((m): m is { name: string; srcPath?: string; targets?: Array<{ name?: string }> } => Boolean(m.name))
    .map((m) => ({
      name: m.name,
      srcPath: m.srcPath ?? `./${m.name}`,
      targets: (m.targets ?? []).map((t) => t.name).filter((n): n is string => Boolean(n)),
    }));
}
