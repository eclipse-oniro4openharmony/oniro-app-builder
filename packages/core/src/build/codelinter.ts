import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { runProcess } from '../hdc/exec.js';
import { getCmdToolsBin } from '../sdk/paths.js';

export interface CodelinterFinding {
  file: string;
  line: number;
  severity: string;
  /** Rule code/id when present in the output, else ''. */
  code: string;
  message: string;
}

export interface CodelinterResult {
  /** codelinter process exit code. */
  code: number;
  findings: CodelinterFinding[];
  /** Combined stdout+stderr, for callers that want the raw report. */
  raw: string;
}

const FINDING_RE = /^(.*?):(\d+):(?:\d+:)?\s*(error|warning|warn|info)\b[:\s-]*(.*)$/i;
const TRAILING_CODE_RE = /[([]([\w@/.\-]+)[)\]]\s*$/;

/**
 * Best-effort parser for codelinter output lines of the shape
 * `<file>:<line>[:<col>]: <severity>: <message> [<rule-code>]`. Lines that don't
 * match are ignored. Exported as a pure function so it is unit-testable.
 */
export function parseCodelinterFindings(output: string): CodelinterFinding[] {
  const findings: CodelinterFinding[] = [];
  for (const raw of output.split('\n')) {
    const m = FINDING_RE.exec(raw.trim());
    if (!m) continue;
    let message = m[4]!.trim();
    let code = '';
    const codeMatch = TRAILING_CODE_RE.exec(message);
    if (codeMatch) {
      code = codeMatch[1]!;
      message = message.slice(0, codeMatch.index).trim();
    }
    findings.push({ file: m[1]!.trim(), line: Number(m[2]), severity: m[3]!.toLowerCase(), code, message });
  }
  return findings;
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

/** Run the OpenHarmony codelinter and return parsed findings + the raw report. */
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
  return { code: res.code, findings: parseCodelinterFindings(raw), raw };
}
