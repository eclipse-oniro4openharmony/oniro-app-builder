import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger, scopedLogger } from '../ports/logger.js';
import { CommandFailedError, OniroError, SdkNotInstalledError } from '../ports/errors.js';
import { runHvigorw } from './runHvigorw.js';
import { ensureOhModules } from './ohpm.js';
import { discoverHaps, type ModuleHaps } from './discoverHaps.js';
import { getOhosBaseSdkHome, toLongPath } from '../sdk/paths.js';
import { detectProjectSdkVersion, findMissingProjectSdk } from '../sdk/detectProjectSdk.js';
import { OHOS_DAILY_BUILDS_URL } from '../sdk/constants.js';
import { detectRuntimeOs } from '../harmonyos/target.js';
import { findHarmonyOsSdk, findHarmonyOsTool } from '../harmonyos/sdk.js';
import {
  buildOutputTail,
  dependencyApiDiagnostic,
  parseBuildOutput,
  sdkTooOldDiagnostic,
  type BuildDiagnostic,
} from './diagnostics.js';
import { describeBuildSdk, resolveBuildSdk, type BuildSdk } from './buildSdk.js';
import { signingMismatch } from './signingCheck.js';

/** How to build against a newer SDK, for the dependency hint. */
const NEWER_SDK_REMEDY: Record<BuildSdk['runtimeOS'], string> = {
  HarmonyOS:
    'install newer HarmonyOS command-line tools (`oniro-app cmdtools install --from-zip <zip> --force`; ' +
    '`oniro-app cmdtools status` shows the API level of the current ones), then raise compileSdkVersion to their release.',
  OpenHarmony:
    'install a newer SDK (`oniro-app sdk list`, `oniro-app sdk install <version>`) and raise compileSdkVersion ' +
    'and compatibleSdkVersion in build-profile.json5 to its API level.',
};

/** How much of the build output is kept for {@link diagnoseBuildFailure}, from the end. */
const DIAGNOSIS_OUTPUT_LIMIT = 2_000_000;

/**
 * A hint for build output whose cause the compiler errors do not name, or
 * undefined. Pure/testable. A symbol missing from a kit reads as a system API
 * unless `newerSdkHasIt`, when a newer installed SDK declares it (see
 * {@link sdkTooOldDiagnostic}).
 */
export function diagnoseBuildFailure(output: string, newerSdkHasIt = false): string | undefined {
  if (!newerSdkHasIt && /is not exported from Kit|has no exported member .*@systemapi/i.test(output)) {
    return (
      'The project calls system APIs (`@systemapi`), which the public SDK leaves out. Build against the ' +
      `full OpenHarmony SDK: download an \`ohos-sdk-full\` archive from ${OHOS_DAILY_BUILDS_URL} and ` +
      'install it with `oniro-app sdk install --from-archive <archive> --force` (this replaces the public ' +
      'SDK of that API level; set ONIRO_SDK_ROOT_DIR to keep the two apart). Installing such an app also ' +
      'needs privileged signing (`oniro-app sign --apl system_core --acls … --app-privilege-capabilities …`).'
    );
  }
  // 00308018 is hvigor's catch-all ("Unknown Error", also around every failed
  // native build), so it only counts when its message is about the SDK.
  if (/SDK path does not exist|SDK license agreement is not accepted/i.test(output) || /00308018[^\n]*\n[^\n]*\bSDK\b/.test(output)) {
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

export interface BuildSummary {
  /** Distinct error diagnostics. */
  errors: number;
  /** Distinct warning diagnostics. */
  warnings: number;
  /** hvigor's `COMPILE RESULT` error count, which can exceed `errors`. */
  reportedErrors?: number;
  reportedWarnings?: number;
}

export interface BuildHapResult {
  exitCode: number;
  durationMs: number;
  /** Built HAPs grouped by module folder. */
  discoveredHaps: Record<string, ModuleHaps>;
  warnings: string[];
  /** Compiler warnings (and errors, for a failed build) parsed from the output. */
  diagnostics: BuildDiagnostic[];
  summary: BuildSummary;
  /** The SDK the build compiled against, when it could be told. */
  sdk?: BuildSdk;
}

/**
 * The build ran and failed: hvigor (or the `ohpm install` before it) exited
 * non-zero. Carries what {@link parseBuildOutput} found, so callers need not
 * scrape the output.
 */
export class BuildFailedError extends OniroError {
  /** The SDK hvigor compiled against, when it could be told (not for an ohpm failure). */
  public sdk?: BuildSdk;

  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly diagnostics: BuildDiagnostic[],
    public readonly summary: BuildSummary,
    public readonly rawTail: string,
    public readonly failedTask?: string,
    public readonly hint?: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'BuildFailedError';
  }
}

function summarise(diagnostics: readonly BuildDiagnostic[], parsed: { reportedErrors?: number; reportedWarnings?: number }): BuildSummary {
  const summary: BuildSummary = {
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
  };
  if (parsed.reportedErrors !== undefined) summary.reportedErrors = parsed.reportedErrors;
  if (parsed.reportedWarnings !== undefined) summary.reportedWarnings = parsed.reportedWarnings;
  return summary;
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
    let ohpmOutput = '';
    try {
      const r = await ensureOhModules({
        config: opts.config,
        projectDir,
        ohpmPath: (harmonySdk && findHarmonyOsTool(harmonySdk, 'ohpm')) ?? undefined,
        abortSignal: opts.abortSignal,
        onOutput: (chunk, stream) => {
          ohpmOutput = (ohpmOutput + chunk).slice(-DIAGNOSIS_OUTPUT_LIMIT);
          opts.onOutput?.(chunk, stream);
        },
        logger: opts.logger,
      });
      if (r.installed) logger.info('ran ohpm install --all (oh_modules was missing)');
    } catch (err) {
      if (!(err instanceof CommandFailedError)) throw err;
      const parsed = parseBuildOutput(ohpmOutput || err.stderr, { projectDir });
      const diagnostics = parsed.diagnostics.length
        ? parsed.diagnostics
        : [{ severity: 'error' as const, source: 'ohpm' as const, message: err.message.split('\n')[0]! }];
      throw new BuildFailedError(
        err.message,
        err.exitCode,
        diagnostics,
        summarise(diagnostics, parsed),
        buildOutputTail(ohpmOutput || err.stderr),
        'ohpm install --all',
        undefined,
        err,
      );
    }
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
    // Not run at all (cancelled, hvigorw missing, not a project): no build output to read.
    if (!(err instanceof OniroError) || !/^hvigorw exited with code (\d+)/.test(err.message)) throw err;
    const exitCode = Number(/code (\d+)/.exec(err.message)![1]);
    const parsed = parseBuildOutput(output, { projectDir });
    const diagnostics = [...parsed.diagnostics];
    const tooOld = isHarmonyOs
      ? null
      : sdkTooOldDiagnostic(diagnostics, getOhosBaseSdkHome(opts.config), detectProjectSdkVersion(projectDir));
    if (tooOld) diagnostics.push(tooOld);
    // Name the SDK used: an SDK too old for a dependency otherwise shows only as
    // ArkTS errors deep inside oh_modules/ (#22).
    const sdk = resolveBuildSdk({ config: opts.config, projectDir, runtimeOS: isHarmonyOs ? 'HarmonyOS' : 'OpenHarmony' });
    const sdkLabel = sdk ? describeBuildSdk(sdk) : undefined;
    const depHint = dependencyApiDiagnostic(
      diagnostics,
      sdkLabel,
      NEWER_SDK_REMEDY[isHarmonyOs ? 'HarmonyOS' : 'OpenHarmony'],
    );
    if (depHint) diagnostics.push(depHint);
    const hint = tooOld?.message ?? depHint?.message ?? diagnoseBuildFailure(output);
    const footer = sdkLabel && !depHint ? `Built against ${sdkLabel}.` : undefined;
    const failed = new BuildFailedError(
      [err.message, hint, footer].filter(Boolean).join('\n'),
      exitCode,
      diagnostics,
      summarise(diagnostics, parsed),
      buildOutputTail(output),
      parsed.failedTask,
      hint,
      err,
    );
    if (sdk) failed.sdk = sdk;
    throw failed;
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

  const parsed = parseBuildOutput(output, { projectDir });
  const diagnostics = [...parsed.diagnostics];
  const runtimeOS = isHarmonyOs ? 'HarmonyOS' : 'OpenHarmony';
  // A HAP signed with the other runtime's material still comes out `-signed`;
  // only the install on a device would tell (#19). Warn, do not refuse.
  const mismatch = anySigned ? signingMismatch(projectDir, runtimeOS, opts.product) : undefined;
  if (mismatch) {
    warnings.push(mismatch);
    diagnostics.push({ severity: 'warning', source: 'signing', message: mismatch, file: 'build-profile.json5' });
  }
  const sdk = resolveBuildSdk({ config: opts.config, projectDir, runtimeOS });
  return {
    exitCode,
    durationMs: Date.now() - start,
    discoveredHaps,
    warnings,
    diagnostics,
    summary: summarise(diagnostics, parsed),
    ...(sdk ? { sdk } : {}),
  };
}

/** What {@link buildWithDiagnostics} returns: one shape for a build that passed and one that failed. */
export interface BuildReport {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  /** The first task hvigor reported failed, or `ohpm install --all`. */
  failedTask?: string;
  diagnostics: BuildDiagnostic[];
  summary: BuildSummary;
  /** Built HAPs grouped by module folder; empty when the build failed. */
  discoveredHaps: Record<string, ModuleHaps>;
  warnings: string[];
  /** The error message the build failed with (what `oniro-app build` prints). */
  error?: string;
  /** The SDK the project compiles against is not installed: install it and build again. */
  missingSdk?: { api: string; version?: string; expectedPath: string };
  /**
   * The SDK hvigor compiled against (`runtimeOS`, `displayName`, `version`, `api`,
   * `path`), when it could be told. Absent for an ohpm failure or a missing SDK.
   */
  sdk?: BuildSdk;
  /** The last 200 lines of build output, colour codes removed. Empty for a successful build. */
  rawTail: string;
}

/**
 * {@link buildHap}, but a build that fails returns `ok: false` with the parsed
 * diagnostics instead of throwing, as does a project whose SDK is not installed
 * (one `sdk` diagnostic, plus `missingSdk`). Errors that mean the build could not
 * run at all (no command-line tools, not a project, cancelled) still throw.
 */
export async function buildWithDiagnostics(opts: BuildHapOptions): Promise<BuildReport> {
  const start = Date.now();
  try {
    const r = await buildHap(opts);
    return { ok: true, ...r, rawTail: '' };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (err instanceof BuildFailedError) {
      const report: BuildReport = {
        ok: false,
        exitCode: err.exitCode,
        durationMs,
        diagnostics: err.diagnostics,
        summary: err.summary,
        discoveredHaps: {},
        warnings: [],
        error: err.message,
        rawTail: err.rawTail,
      };
      if (err.failedTask) report.failedTask = err.failedTask;
      if (err.sdk) report.sdk = err.sdk;
      return report;
    }
    if (err instanceof SdkNotInstalledError) {
      const diagnostic: BuildDiagnostic = { severity: 'error', source: 'sdk', api: err.api, message: err.message };
      return {
        ok: false,
        exitCode: 1,
        durationMs,
        diagnostics: [diagnostic],
        summary: { errors: 1, warnings: 0 },
        discoveredHaps: {},
        warnings: [],
        error: err.message,
        missingSdk: { api: err.api, expectedPath: err.expectedPath, ...(err.version ? { version: err.version } : {}) },
        rawTail: '',
      };
    }
    throw err;
  }
}
