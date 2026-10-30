import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { runHvigorw } from './runHvigorw.js';
import { ensureOhModules } from './ohpm.js';
import { discoverHaps, type ModuleHaps } from './discoverHaps.js';
import { toLongPath } from '../sdk/paths.js';
import { findMissingProjectSdk } from '../sdk/detectProjectSdk.js';
import { OHOS_DAILY_BUILDS_URL } from '../sdk/constants.js';
import { detectRuntimeOs } from '../harmonyos/target.js';
import { findHarmonyOsSdk, findHarmonyOsTool } from '../harmonyos/sdk.js';

/** How much of the build output is kept for {@link diagnoseBuildFailure}, from the end. */
const DIAGNOSIS_OUTPUT_LIMIT = 2_000_000;

/**
 * A hint for build output whose cause the compiler errors do not name, or
 * undefined. Pure/testable.
 */
export function diagnoseBuildFailure(output: string): string | undefined {
  if (/is not exported from Kit|has no exported member .*@systemapi/i.test(output)) {
    return (
      'The project calls system APIs (`@systemapi`), which the public SDK leaves out. Build against the ' +
      `full OpenHarmony SDK: download an \`ohos-sdk-full\` archive from ${OHOS_DAILY_BUILDS_URL} and ` +
      'install it with `oniro-app sdk install --from-archive <archive> --force` (this replaces the public ' +
      'SDK of that API level; set ONIRO_SDK_ROOT_DIR to keep the two apart). Installing such an app also ' +
      'needs privileged signing (`oniro-app sign --apl system_core --acls … --app-privilege-capabilities …`).'
    );
  }
  if (/00308018|SDK path does not exist|SDK license agreement is not accepted/i.test(output)) {
    return 'hvigor cannot find the SDK the project compiles against: check `oniro-app sdk list` against compileSdkVersion.';
  }
  return undefined;
}

export interface BuildHapOptions {
  config: ConfigProvider;
  projectDir: string;
  product?: string;
  module?: string;
  /** Forwarded as hvigor `buildMode` (e.g. release, debug). */
  mode?: string;
  /** hvigor task. Default `assembleHap`. */
  task?: string;
  /** Run `ohpm install --all` first when `oh_modules/` is missing. Default true. */
  autoInstallDeps?: boolean;
  /** Build modules in parallel. Default true (see runHvigorw). */
  parallel?: boolean;
  abortSignal?: AbortSignal;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  logger?: Logger;
}

export interface BuildHapResult {
  exitCode: number;
  durationMs: number;
  /** Built HAPs grouped by module folder. */
  discoveredHaps: Record<string, ModuleHaps>;
  warnings: string[];
}

/**
 * High-level build orchestration: ensure deps → run hvigorw → discover the
 * produced HAPs. The single call the CLI and MCP want; `runHvigorw` stays a raw
 * single-spawn primitive.
 */
export async function buildHap(opts: BuildHapOptions): Promise<BuildHapResult> {
  const logger = scopedLogger(opts.logger ?? noopLogger, 'build');
  const warnings: string[] = [];
  const start = Date.now();
  // Normalise once so ohpm, hvigor and HAP discovery all agree on the project
  // dir, and the returned artifact paths come back in long form.
  const projectDir = toLongPath(opts.projectDir);
  const isHarmonyOs = detectRuntimeOs(projectDir, opts.product) === 'HarmonyOS';

  // Fail before ohpm and hvigor run, with the release to install, rather than on
  // hvigor's own late and vaguer error.
  const missingSdk = isHarmonyOs ? null : findMissingProjectSdk(opts.config, projectDir);
  if (missingSdk) throw missingSdk;

  if (opts.autoInstallDeps !== false) {
    // HarmonyOS projects install dependencies with their own install's ohpm.
    const harmonySdk = isHarmonyOs ? findHarmonyOsSdk({ config: opts.config, logger: opts.logger }) : null;
    const r = await ensureOhModules({
      config: opts.config,
      projectDir,
      ohpmPath: (harmonySdk && findHarmonyOsTool(harmonySdk, 'ohpm')) ?? undefined,
      abortSignal: opts.abortSignal,
      onOutput: opts.onOutput,
      logger: opts.logger,
    });
    if (r.installed) logger.info('ran ohpm install --all (oh_modules was missing)');
  }

  let output = '';
  let exitCode: number;
  try {
    ({ exitCode } = await runHvigorw({
      config: opts.config,
      projectDir,
      product: opts.product,
      module: opts.module,
      buildMode: opts.mode,
      task: opts.task,
      parallel: opts.parallel,
      abortSignal: opts.abortSignal,
      onOutput: (chunk, stream) => {
        output = (output + chunk).slice(-DIAGNOSIS_OUTPUT_LIMIT);
        opts.onOutput?.(chunk, stream);
      },
      logger: opts.logger,
    }));
  } catch (err) {
    const hint = diagnoseBuildFailure(output);
    if (hint && err instanceof OniroError) throw new OniroError(`${err.message}\n${hint}`, err);
    throw err;
  }

  const discoveredHaps = await discoverHaps({ projectDir });
  const anySigned = Object.values(discoveredHaps).some((m) => m.signed.length > 0);
  if (!anySigned) {
    warnings.push(
      isHarmonyOs
        ? 'No signed HAPs found. The HarmonyOS emulator installs the unsigned HAP as it is; for a device, ' +
            'run `oniro-app sign --harmonyos` to have AppGallery Connect issue a certificate and profile.'
        : 'No signed HAPs found: most OpenHarmony targets reject unsigned HAPs. Run `oniro-app sign` ' +
            'to generate local signing material, then build again.',
    );
  }

  return { exitCode, durationMs: Date.now() - start, discoveredHaps, warnings };
}
