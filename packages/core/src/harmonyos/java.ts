import * as fs from 'node:fs';
import * as path from 'node:path';
import { OniroError } from '../ports/errors.js';
import type { HarmonyOsSdk } from './sdk.js';

const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java';

/**
 * Locate a Java runtime for `hap-sign-tool.jar`: `JAVA_HOME`, then the JetBrains
 * Runtime DevEco Studio bundles (so Studio users need no separate JDK), then `PATH`.
 */
export function findJava(sdk?: HarmonyOsSdk, env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.JAVA_HOME && path.join(env.JAVA_HOME, 'bin', JAVA_BIN),
    sdk && path.join(sdk.installRoot, 'jbr', 'bin', JAVA_BIN),
    // macOS: the JBR is itself a bundle inside Studio's Contents.
    sdk && path.join(sdk.installRoot, 'jbr', 'Contents', 'Home', 'bin', JAVA_BIN),
    ...(env.PATH ?? '').split(path.delimiter).map((dir) => dir && path.join(dir, JAVA_BIN)),
  ];
  const found = candidates.find((c): c is string => !!c && fs.existsSync(c));
  if (found) return found;
  throw new OniroError(
    'No Java runtime found. HarmonyOS signing runs the SDK\'s hap-sign-tool.jar, which needs one: ' +
      'install a JDK and set JAVA_HOME, or install DevEco Studio, whose bundled runtime is used automatically.',
  );
}
