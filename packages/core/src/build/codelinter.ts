import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { runProcess } from '../hdc/exec.js';
import { getCmdToolsBin } from '../sdk/paths.js';

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
  /** codelinter process exit code: 1 whenever it found any defect, warnings included. */
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
const NOTICE_RE = /does not match that of the project|error occurred during linting|incomplete report/i;
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

/** Run the OpenHarmony codelinter and return the parsed report + the cleaned raw output. */
export async function runCodelinter(opts: RunCodelinterOptions): Promise<CodelinterResult> {
  const res = await runProcess({
    command: getCmdToolsBin(opts.config, 'codelinter'),
    args: opts.files?.length ? [...opts.files] : [],
    cwd: opts.projectDir,
    timeoutMs: opts.timeoutMs ?? 600_000,
    abortSignal: opts.abortSignal,
    logger: opts.logger,
  });
  const raw = `${res.stdout}${res.stderr}`;
  return { code: res.code, ...parseCodelinterReport(raw), raw: cleanCodelinterOutput(raw) };
}
