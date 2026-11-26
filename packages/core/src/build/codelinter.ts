import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import { type Logger, noopLogger } from '../ports/logger.js';
import { runProcess } from '../hdc/exec.js';
import { SdkNotInstalledError } from '../ports/errors.js';
import { getCmdToolsPath, getOhosBaseSdkHome } from '../sdk/paths.js';
import { ALL_SDKS } from '../sdk/constants.js';
import { detectProjectSdk } from '../sdk/detectProjectSdk.js';
import { expectedSdkApiDir, findSdkApiDir } from '../sdk/apiDir.js';
import { withLocalPropertiesSdkDir } from '../sdk/localProperties.js';
import { detectRuntimeOs, type RuntimeOs } from '../harmonyos/target.js';
import { requireHarmonyOsSdk } from '../harmonyos/sdk.js';
import { detectCmdToolsFlavour } from '../cmdTools/install.js';

export interface CodelinterFinding {
  file: string;
  line: number;
  /** Column, when the report gives one. */
  column?: number;
  /** `error`, `warning`, `suggestion` or `info` (codelinter's `warn` reads as `warning`). */
  severity: string;
  /** Rule code/id when present in the output, else ''. */
  code: string;
  message: string;
}

/** codelinter's own totals, from its `-Defects: N; Errors: N; Warns: N; Suggestions: N;` line. */
export interface CodelinterSummary {
  defects: number;
  errors: number;
  warnings: number;
  suggestions: number;
}

export interface CodelinterReport {
  findings: CodelinterFinding[];
  /** The totals codelinter printed (all zero for "No defects found"), or null when it printed none. */
  summary: CodelinterSummary | null;
  /**
   * codelinter's remarks about the run itself rather than the code, e.g. "The type of
   * command line tools does not match that of the project".
   */
  notices: string[];
  /** True when codelinter warned that the report may be incomplete. */
  incomplete: boolean;
}

export interface CodelinterResult extends CodelinterReport {
  /**
   * codelinter process exit code: 0 after a run that printed its report, whatever it
   * found; non-zero when it did not run (1 for a bad option, 255 for an internal error).
   */
  code: number;
  /** Combined stdout+stderr, with colour codes and progress-bar redraws removed. */
  raw: string;
}

/** Legacy one-line shape: `<file>:<line>[:<col>]: <severity>: <message> [<rule>]`. */
const FINDING_RE = /^(.*?):(\d+):(?:(\d+):)?\s*(error|warning|warn|suggestion|info)\b[:\s-]*(.*)$/i;
const TRAILING_CODE_RE = /[([]([\w@/.\-]+)[)\]]\s*$/;
/** Table shape: a `<file>(<count>)` header, then `<line>:<col>  <severity>  <message>  <rule>` rows. */
const FILE_HEADER_RE = /^(.+\.\w+)\((\d+)\)$/;
const ROW_RE = /^(\d+):(\d+)\s+(error|warning|warn|suggestion|info)\s+(.*)$/i;
const RULE_RE = /^@?[\w.-]+(?:\/[\w.-]+)+$/;
const SUMMARY_RE = /Defects:\s*(\d+);\s*Errors:\s*(\d+);\s*Warns:\s*(\d+);\s*Suggestions:\s*(\d+)/i;
/** Remarks meaning codelinter skipped part of the run; `<path> not exists` is a dropped file argument. */
const NOTICE_RE = /does not match that of the project|error occurred during linting|incomplete report| not exists$/i;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * codelinter output as plain lines: colour codes stripped, and of each line redrawn
 * with `\r` (its progress bar) only the final state kept.
 */
export function cleanCodelinterOutput(output: string): string {
  return output
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => (line.split('\r').filter((s) => s.trim() !== '').pop() ?? '').trimEnd())
    .join('\n');
}

function normaliseSeverity(s: string): string {
  const lower = s.toLowerCase();
  return lower === 'warn' ? 'warning' : lower;
}

/**
 * Parse a codelinter report. Pure/testable. Understands the table codelinter prints
 * (a `<file>(<count>)` header followed by `<line>:<col>  <severity>  <message>  <rule>`
 * rows, then a `-Defects: …` summary) and the one-line
 * `<file>:<line>[:<col>]: <severity>: <message> [<rule>]` shape. Other lines are ignored.
 */
export function parseCodelinterReport(output: string): CodelinterReport {
  const findings: CodelinterFinding[] = [];
  const notices: string[] = [];
  let summary: CodelinterSummary | null = null;
  let file = '';

  for (const rawLine of cleanCodelinterOutput(output).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const row = ROW_RE.exec(line);
    if (row) {
      // A row before any file header has nothing to attach to.
      if (!file) continue;
      const columns = row[4]!.trim().split(/\s{2,}/);
      const last = columns[columns.length - 1]!;
      const code = columns.length > 1 && RULE_RE.test(last) ? last : '';
      const message = (code ? columns.slice(0, -1) : columns).join(' ').trim();
      findings.push({
        file,
        line: Number(row[1]),
        column: Number(row[2]),
        severity: normaliseSeverity(row[3]!),
        code,
        message,
      });
      continue;
    }
    const header = FILE_HEADER_RE.exec(line);
    if (header) {
      file = header[1]!;
      continue;
    }
    const legacy = FINDING_RE.exec(line);
    if (legacy) {
      let message = legacy[5]!.trim();
      let code = '';
      const codeMatch = TRAILING_CODE_RE.exec(message);
      if (codeMatch) {
        code = codeMatch[1]!;
        message = message.slice(0, codeMatch.index).trim();
      }
      const finding: CodelinterFinding = {
        file: legacy[1]!.trim(),
        line: Number(legacy[2]),
        severity: normaliseSeverity(legacy[4]!),
        code,
        message,
      };
      if (legacy[3]) finding.column = Number(legacy[3]);
      findings.push(finding);
      continue;
    }
    const totals = SUMMARY_RE.exec(line);
    if (totals) {
      summary = {
        defects: Number(totals[1]),
        errors: Number(totals[2]),
        warnings: Number(totals[3]),
        suggestions: Number(totals[4]),
      };
      continue;
    }
    if (/no defects found/i.test(line)) {
      summary = { defects: 0, errors: 0, warnings: 0, suggestions: 0 };
      continue;
    }
    if (NOTICE_RE.test(line)) notices.push(line);
  }

  return { findings, summary, notices, incomplete: notices.length > 0 };
}

/** The findings of a codelinter report; see {@link parseCodelinterReport}. */
export function parseCodelinterFindings(output: string): CodelinterFinding[] {
  return parseCodelinterReport(output).findings;
}

/**
 * The files of a DevEco project root, relative to it, that codelinter needs to run.
 * Each entry lists the names that satisfy it; older templates use `hvigorfile.js`.
 */
const PROJECT_ROOT_FILES = [
  ['build-profile.json5'],
  ['hvigorfile.ts', 'hvigorfile.js'],
  [path.join('hvigor', 'hvigor-config.json5')],
];

/**
 * Which of the project-root files codelinter needs are missing from `projectDir`,
 * each named by its first form. Without them codelinter exits non-zero without a
 * report, and says neither why nor which file.
 */
export function missingProjectRootFiles(projectDir: string): string[] {
  return PROJECT_ROOT_FILES.filter((names) => !names.some((f) => fs.existsSync(path.join(projectDir, f)))).map(
    (names) => names[0]!,
  );
}

export interface RunCodelinterOptions {
  config: ConfigProvider;
  projectDir: string;
  /** Files/globs to lint; when omitted, codelinter is run with no file args. */
  files?: readonly string[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  logger?: Logger;
}

/**
 * The SDK argument that makes codelinter lint an OpenHarmony project: it then reads
 * the SDK from `local.properties` `sdk.dir`. The tools' `bin/codelinter` launcher
 * always passes `<tools>/sdk` instead, which codelinter accepts for HarmonyOS
 * projects only ("The type of command line tools does not match that of the project").
 */
export const CODELINTER_OHOS_SDK_ARG = 'ohosSdkPath';

/** The product codelinter lints when not given `-p`. */
const CODELINTER_PRODUCT = 'default';

/** How {@link runCodelinter} runs codelinter for a project. */
export interface CodelinterInvocation {
  /** The Node.js bundled with the command-line tools. */
  command: string;
  /** `<tools>/codelinter/index.js`, the SDK argument, then the files to lint. */
  args: string[];
  /** The project's `runtimeOS`, which picks the SDK argument. */
  runtimeOS: RuntimeOs;
  /**
   * OpenHarmony projects only: the SDK home to set as `local.properties` `sdk.dir`
   * for the run, when the project's own `local.properties` does not hold its
   * `compileSdkVersion`.
   */
  sdkDir?: string;
}

/**
 * `sdk.dir` as codelinter reads it from the project's `local.properties`: the last
 * line starting with `sdk.dir`, the text after `=`, trimmed and not unescaped. A
 * relative path is relative to the project, codelinter's working directory.
 */
function codelinterSdkDir(projectDir: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(projectDir, 'local.properties'), 'utf8');
  } catch {
    return undefined;
  }
  let dir: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('sdk.dir')) dir = line.split('=')[1]?.trim();
  }
  return dir ? path.resolve(projectDir, dir) : undefined;
}

type GlobSync = (pattern: string, options: { cwd: string }) => string[];

/**
 * `files` with glob patterns expanded against the project, as the shell in the
 * tools' `bin/codelinter` launcher did on Linux and macOS: codelinter takes only
 * existing paths. Needs Node.js 22 (`fs.globSync`); before that, and for a pattern
 * matching nothing, the pattern is passed on and codelinter says it does not exist.
 */
export function expandCodelinterFiles(projectDir: string, files: readonly string[]): string[] {
  const globSync = (fs as unknown as { globSync?: GlobSync }).globSync;
  return files.flatMap((f) => {
    if (!globSync || !/[*?[{]/.test(f)) return [f];
    const matches = globSync(f, { cwd: projectDir }).sort();
    return matches.length ? matches : [f];
  });
}

/**
 * How to run codelinter on a project with any command-line tools, whichever SDK
 * they bundle. Runs `codelinter/index.js` under the tools' Node.js with the SDK
 * argument the project's `runtimeOS` needs:
 * - OpenHarmony: {@link CODELINTER_OHOS_SDK_ARG}, and the OpenHarmony SDK home
 *   (from `oniro-app sdk install`) in `local.properties` unless the `sdk.dir`
 *   codelinter reads there already holds the project's API level. Throws
 *   `SdkNotInstalledError` when neither holds it.
 * - HarmonyOS: the tools' own `sdk` when they bundle the HarmonyOS SDK, as their
 *   launcher passes it; else the HarmonyOS SDK a build would use. Throws when
 *   there is none.
 */
export function codelinterInvocation(
  config: ConfigProvider,
  projectDir: string,
  files: readonly string[] = [],
  logger: Logger = noopLogger,
): CodelinterInvocation {
  const tools = getCmdToolsPath(config);
  const command =
    process.platform === 'win32'
      ? path.join(tools, 'tool', 'node', 'node.exe')
      : path.join(tools, 'tool', 'node', 'bin', 'node');
  const entry = path.join(tools, 'codelinter', 'index.js');
  const lintFiles = expandCodelinterFiles(projectDir, files);
  const runtimeOS = detectRuntimeOs(projectDir, CODELINTER_PRODUCT);

  if (runtimeOS === 'HarmonyOS') {
    const sdkPath =
      detectCmdToolsFlavour(tools) === 'HarmonyOS'
        ? path.join(tools, 'sdk')
        : requireHarmonyOsSdk({ config, logger }).sdkPath;
    return { command, args: [entry, sdkPath, ...lintFiles], runtimeOS };
  }

  const invocation: CodelinterInvocation = { command, args: [entry, CODELINTER_OHOS_SDK_ARG, ...lintFiles], runtimeOS };
  const sdk = detectProjectSdk(projectDir, noopLogger, CODELINTER_PRODUCT);
  if (sdk === undefined) return invocation;
  const { api, declared } = sdk;
  const localSdkDir = codelinterSdkDir(projectDir);
  if (localSdkDir && findSdkApiDir(localSdkDir, api, declared)) return invocation;
  const home = getOhosBaseSdkHome(config);
  if (!findSdkApiDir(home, api, declared)) {
    throw new SdkNotInstalledError(
      String(api),
      expectedSdkApiDir(home, api, declared),
      ALL_SDKS.find((s) => s.api === String(api))?.version,
    );
  }
  invocation.sdkDir = home;
  return invocation;
}

/**
 * Run codelinter (see {@link codelinterInvocation}) and return the parsed report and
 * the cleaned raw output. For an OpenHarmony project whose `local.properties` does
 * not name its SDK, the file names it for the run and is restored afterwards, also
 * when `abortSignal` fires.
 */
export async function runCodelinter(opts: RunCodelinterOptions): Promise<CodelinterResult> {
  const invocation = codelinterInvocation(opts.config, opts.projectDir, opts.files, opts.logger);
  // The launcher creates codelinter's log directory before each run.
  try {
    fs.mkdirSync(path.join(getCmdToolsPath(opts.config), 'codelinter', 'linter', 'result'), { recursive: true });
  } catch {
    // Read-only tools: codelinter reports what it cannot write.
  }
  const run = () =>
    runProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: opts.projectDir,
      timeoutMs: opts.timeoutMs ?? 600_000,
      abortSignal: opts.abortSignal,
      logger: opts.logger,
    });
  const res = invocation.sdkDir ? await withLocalPropertiesSdkDir(opts.projectDir, invocation.sdkDir, run) : await run();
  const raw = `${res.stdout}${res.stderr}`;
  return { code: res.code, ...parseCodelinterReport(raw), raw: cleanCodelinterOutput(raw) };
}
