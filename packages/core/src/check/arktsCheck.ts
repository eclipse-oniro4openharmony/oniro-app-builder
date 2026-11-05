import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError, SdkNotInstalledError } from '../ports/errors.js';
import { runProcess } from '../hdc/exec.js';
import { detectProjectSdkVersion, findMissingProjectSdk, resolveProjectSdkDir } from '../sdk/detectProjectSdk.js';
import { detectRuntimeOs, type RuntimeOs } from '../harmonyos/target.js';
import { findHarmonyOsSdk } from '../harmonyos/sdk.js';
import type { BuildDiagnostic } from '../build/diagnostics.js';

/**
 * `check arkts`: the SDK's own ArkTS checker (ets-loader's `etsStandaloneChecker`,
 * the type and linter pass `CompileArkTS` runs) plus the ArkUI component-model and
 * project-config rules hvigor enforces later in a build, without a build. It runs
 * deveco-cli's `arkts-check.cjs` (MIT, vendored under `vendor/deveco-cli/`, adapted
 * to take the SDK directory) in a child node process, against the SDK the project
 * compiles with.
 */

/** Where the SDK the checker loads came from. */
export interface ArktsCheckSdk {
  /** The directory holding `ets/`, `previewer/` and `toolchains/`. */
  dir: string;
  runtimeOS: RuntimeOs;
  /** The project's `compileSdkVersion` API level, for an OpenHarmony project. */
  api?: number;
  /** HarmonyOS's `hms/ets`, added to the checker's API paths. */
  hmsEtsDir?: string;
}

export interface ArktsCheckSummary {
  errors: number;
  warnings: number;
  fixed: number;
  /** Source files the checker was given. */
  files: number;
  /**
   * Diagnostics that came from the SDK's ArkTS checker rather than the project rules.
   * Zero alongside project-rule findings can mean the checker produced nothing, so it
   * is reported rather than inferred.
   */
  checkerDiagnostics: number;
}

export interface ArktsCheckReport {
  /** True when the check ran and found no error. */
  ok: boolean;
  /** False when the checker could not run or crashed: then nothing is known about the code. */
  completed: boolean;
  diagnostics: BuildDiagnostic[];
  /** Diagnostics `--fix` rewrote away, verified by a re-check. */
  fixed: BuildDiagnostic[];
  /** Files `--fix` edited that were not in `files` (an `export` added in the declaring module). */
  alsoModified: string[];
  summary: ArktsCheckSummary;
  sdk?: ArktsCheckSdk;
  durationMs: number;
  /** Why the check did not complete. */
  error?: string;
}

export interface ArktsCheckOptions {
  config: ConfigProvider;
  projectDir: string;
  /** Check only these `.ets` files (relative to the project or absolute); project-wide rules are skipped. */
  files?: string[];
  /** Apply the checker's verified fixes (compiler suggestions, import paths, missing `export`, ...). */
  fix?: boolean;
  /** Override the SDK directory (holding `ets/`); by default the one the project compiles with. */
  sdkDir?: string;
  /** With `sdkDir`: HarmonyOS's `hms/ets` API directory to add. */
  hmsEtsDir?: string;
  /** Kill the checker after this long. Default 300 000 ms. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /** The checker script; tests substitute a stand-in. */
  scriptPath?: string;
  /** The node binary that runs it. Default: the one running this process. */
  nodePath?: string;
}

/** The raw result `arkts-check.cjs` prints. */
interface CheckerOutput {
  success?: boolean;
  error?: string;
  errors?: CheckerDiagnostic[];
  fixed?: CheckerDiagnostic[];
  alsoModified?: string[];
  summary?: { errorCount?: number; warnCount?: number; fixedCount?: number; checkerDiagCount?: number; fileCount?: number };
}

interface CheckerDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity?: string;
  message?: string;
  rule?: string;
}

/**
 * The vendored `arkts-check.cjs`: beside `dist/` once published, two levels up
 * from `src/check/` in the repo.
 */
export function arktsCheckerScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rel = path.join('vendor', 'deveco-cli', 'arkts-check.cjs');
  const candidates = [path.resolve(here, '..', rel), path.resolve(here, '..', '..', rel)];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]!;
}

/**
 * The SDK `check arkts` loads for a project: for HarmonyOS, the located HarmonyOS
 * SDK's `default/openharmony` plus `default/hms/ets`; for OpenHarmony, the API
 * directory named by `compileSdkVersion` under the SDK home (or the project's
 * `local.properties` `sdk.dir`). Throws `SdkNotInstalledError` when that API is not
 * installed, so a caller can offer to install it.
 */
export function resolveArktsCheckSdk(config: ConfigProvider, projectDir: string, logger: Logger = noopLogger): ArktsCheckSdk {
  const runtimeOS = detectRuntimeOs(projectDir);
  if (runtimeOS === 'HarmonyOS') {
    const sdk = findHarmonyOsSdk({ config, logger });
    if (!sdk) {
      throw new OniroError(
        'The project targets HarmonyOS, and no HarmonyOS SDK was found. Set ONIRO_HARMONYOS_SDK_PATH to a ' +
          'DevEco Studio or HarmonyOS command-line-tools install.',
      );
    }
    const hms = path.join(sdk.sdkPath, 'default', 'hms', 'ets');
    return {
      dir: path.join(sdk.sdkPath, 'default', 'openharmony'),
      runtimeOS,
      hmsEtsDir: fs.existsSync(hms) ? hms : undefined,
    };
  }

  const api = detectProjectSdkVersion(projectDir, logger);
  if (api === undefined) {
    throw new OniroError(
      `Cannot tell which SDK ${projectDir} compiles with: build-profile.json5 declares no numeric compileSdkVersion.`,
    );
  }
  const dir = resolveProjectSdkDir(config, projectDir);
  if (!dir) throw findMissingProjectSdk(config, projectDir)!;
  return { dir, runtimeOS, api };
}

function toDiagnostic(d: CheckerDiagnostic): BuildDiagnostic {
  const out: BuildDiagnostic = {
    severity: d.severity === 'error' ? 'error' : 'warning',
    source: 'arkts-check',
    message: d.message ?? '',
  };
  if (d.rule) out.rule = d.rule;
  if (d.file) out.file = d.file.split(path.sep).join('/');
  if (typeof d.line === 'number') out.line = d.line;
  if (typeof d.column === 'number') out.column = d.column;
  return out;
}

/**
 * Turn the checker's stdout into a report. A run that printed no JSON (the checker
 * threw, which it does on purpose rather than report a crash as a clean result) or
 * printed `error` is `completed: false`.
 */
export function parseArktsCheckOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): Omit<ArktsCheckReport, 'sdk' | 'durationMs'> {
  const empty = { errors: 0, warnings: 0, fixed: 0, files: 0, checkerDiagnostics: 0 };
  let out: CheckerOutput | undefined;
  try {
    out = JSON.parse(stdout) as CheckerOutput;
  } catch {
    out = undefined;
  }
  if (!out || typeof out !== 'object') {
    const tail = (stderr || stdout).trim().split('\n').slice(-20).join('\n');
    return {
      ok: false,
      completed: false,
      diagnostics: [],
      fixed: [],
      alsoModified: [],
      summary: empty,
      error: `The ArkTS checker exited ${exitCode} without a result, so nothing was checked.${tail ? `\n${tail}` : ''}`,
    };
  }
  const diagnostics = (out.errors ?? []).map(toDiagnostic);
  const fixed = (out.fixed ?? []).map(toDiagnostic);
  const summary: ArktsCheckSummary = {
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
    fixed: fixed.length,
    files: out.summary?.fileCount ?? 0,
    checkerDiagnostics: out.summary?.checkerDiagCount ?? 0,
  };
  if (out.error) {
    return { ok: false, completed: false, diagnostics, fixed, alsoModified: out.alsoModified ?? [], summary, error: out.error };
  }
  return {
    ok: summary.errors === 0,
    completed: true,
    diagnostics,
    fixed,
    alsoModified: (out.alsoModified ?? []).map((f) => f.split(path.sep).join('/')),
    summary,
  };
}

/**
 * Run `check arkts` on a project. Resolves with `completed: false` and `error` when
 * the checker could not run or crashed; throws only when the SDK cannot be resolved
 * (`SdkNotInstalledError` when the project's API is not installed).
 */
export async function checkArkts(opts: ArktsCheckOptions): Promise<ArktsCheckReport> {
  const logger = opts.logger ?? noopLogger;
  const projectDir = path.resolve(opts.projectDir);
  const started = Date.now();
  if (!fs.existsSync(path.join(projectDir, 'build-profile.json5'))) {
    throw new OniroError(`${projectDir} is not an OpenHarmony project: it has no build-profile.json5.`);
  }

  const sdk: ArktsCheckSdk = opts.sdkDir
    ? {
        dir: path.resolve(opts.sdkDir),
        runtimeOS: detectRuntimeOs(projectDir),
        ...(opts.hmsEtsDir ? { hmsEtsDir: path.resolve(opts.hmsEtsDir) } : {}),
      }
    : resolveArktsCheckSdk(opts.config, projectDir, logger);

  const script = opts.scriptPath ?? arktsCheckerScript();
  const args = [script, '--project', projectDir, '--sdk', sdk.dir];
  if (sdk.hmsEtsDir) args.push('--hms', sdk.hmsEtsDir);
  if (opts.fix) args.push('--fix');
  if (opts.files?.length) args.push('--files', ...opts.files.map((f) => path.resolve(projectDir, f)));
  logger.debug(`[check arkts] ${opts.nodePath ?? process.execPath} ${args.join(' ')}`);

  let result;
  try {
    result = await runProcess({
      command: opts.nodePath ?? process.execPath,
      args,
      cwd: projectDir,
      timeoutMs: opts.timeoutMs ?? 300_000,
      abortSignal: opts.abortSignal,
      logger,
    });
  } catch (err) {
    if (err instanceof SdkNotInstalledError) throw err;
    return {
      ok: false,
      completed: false,
      diagnostics: [],
      fixed: [],
      alsoModified: [],
      summary: { errors: 0, warnings: 0, fixed: 0, files: 0, checkerDiagnostics: 0 },
      sdk,
      durationMs: Date.now() - started,
      error: `The ArkTS checker did not finish: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ...parseArktsCheckOutput(result.stdout, result.stderr, result.code), sdk, durationMs: Date.now() - started };
}
