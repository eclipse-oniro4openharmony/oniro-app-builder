/**
 * Parser for the output of `aa test … -s unittest OpenHarmonyTestRunner` (the
 * Hypium runner). Each case prints a block when it starts (`STATUS_CODE: 1`) and
 * one when it ends, carrying `class=`, `test=`, `stream=` (the failure message),
 * `stack=` (several lines) and `consuming=` (ms). The run ends with
 * `OHOS_REPORT_RESULT: stream=Tests run: N, Failure: F, Error: E, Pass: P, Ignore: I`,
 * `OHOS_REPORT_CODE` and `TestFinished-ResultCode` / `-ResultMsg`.
 */

export type TestStatus = 'pass' | 'fail' | 'error' | 'ignore' | 'unknown';

export interface TestCaseResult {
  /** The `describe` name. */
  suite: string;
  /** The `it` name. */
  name: string;
  status: TestStatus;
  /** The runner's raw `OHOS_REPORT_STATUS_CODE` for the finished case. */
  statusCode: number;
  durationMs?: number;
  /** The assertion or error message (`stream=`), e.g. `expect 0 equals 3`. */
  message?: string;
  /** The JS stack the runner printed, project frames and Hypium frames alike. */
  stack?: string;
}

export interface TestSummary {
  run: number;
  pass: number;
  fail: number;
  error: number;
  ignore: number;
}

export interface ParsedTestOutput {
  tests: TestCaseResult[];
  /** From `OHOS_REPORT_RESULT`, or counted from `tests` when the runner never printed it. */
  summary: TestSummary;
  /** True when `OHOS_REPORT_RESULT` was printed. */
  summaryReported: boolean;
  /** `OHOS_REPORT_CODE`: 0 when every case passed, -1 otherwise. */
  reportCode?: number;
  /** `TestFinished-ResultCode`: 0 when the run itself completed, whatever the cases did. */
  resultCode?: number;
  /** `TestFinished-ResultMsg`, e.g. `The specified module name is not found.` */
  resultMessage?: string;
  /** `taskconsuming=`: the whole run, in ms. */
  durationMs?: number;
  /** For a dry run (`-s dryRun true`): the suites and their cases, without running them. */
  dryRun?: Array<{ suite: string; name: string }>;
}

/**
 * The runner's status codes, as observed with Hypium 1.0.24 on OpenHarmony 7.0:
 * 1 starts a case, 0 passed, -2 an assertion failed, -1 the case threw. -3 is
 * assumed to mean ignored (the code was not observed); anything else is
 * reported as `unknown`, with the raw code kept.
 */
export function statusFromCode(code: number): TestStatus {
  switch (code) {
    case 0:
      return 'pass';
    case -2:
      return 'fail';
    case -1:
      return 'error';
    case -3:
      return 'ignore';
    default:
      return 'unknown';
  }
}

const STATUS_RE = /^OHOS_REPORT_STATUS: (\w+)=(.*)$/;
const STATUS_CODE_RE = /^OHOS_REPORT_STATUS_CODE: (-?\d+)$/;
const RESULT_RE =
  /^OHOS_REPORT_RESULT: stream=Tests run: (\d+), Failure: (\d+), Error: (\d+), Pass: (\d+)(?:, Ignore: (\d+))?/;
const REPORT_CODE_RE = /^OHOS_REPORT_CODE: (-?\d+)$/;
const FINISHED_CODE_RE = /^TestFinished-ResultCode: (-?\d+)$/;
const FINISHED_MSG_RE = /^TestFinished-ResultMsg: (.*)$/;

function countSummary(tests: readonly TestCaseResult[]): TestSummary {
  const count = (s: TestStatus): number => tests.filter((t) => t.status === s).length;
  return { run: tests.length, pass: count('pass'), fail: count('fail'), error: count('error'), ignore: count('ignore') };
}

/** Parse `aa test` output. Pure. Lines that are not runner markers are ignored. */
export function parseTestOutput(output: string): ParsedTestOutput {
  const lines = output.replace(/\r/g, '').split('\n');
  const tests: TestCaseResult[] = [];
  let fields: Record<string, string> = {};
  /** The field a continuation line (a stack frame) belongs to. */
  let lastKey: string | undefined;
  let lastTest: TestCaseResult | undefined;
  let summary: TestSummary | undefined;
  const result: Omit<ParsedTestOutput, 'tests' | 'summary' | 'summaryReported'> = {};

  for (const line of lines) {
    const status = STATUS_RE.exec(line);
    if (status) {
      const [, key, value] = status as unknown as [string, string, string];
      if (key === 'consuming' && lastTest && fields.test === undefined) {
        lastTest.durationMs = Number(value);
      } else if (key === 'taskconsuming') {
        result.durationMs = Number(value);
      } else {
        fields[key] = value;
      }
      lastKey = key;
      continue;
    }
    const code = STATUS_CODE_RE.exec(line);
    if (code) {
      const statusCode = Number(code[1]);
      if (statusCode !== 1 && fields.test !== undefined) {
        const t: TestCaseResult = {
          suite: fields.class ?? '',
          name: fields.test,
          status: statusFromCode(statusCode),
          statusCode,
        };
        const message = fields.stream?.trim();
        if (message) t.message = message.replace(new RegExp(`^Error in ${escapeRe(fields.test)}, `), '');
        const stack = fields.stack?.replace(/\s+$/, '');
        if (stack) t.stack = stack.trim();
        tests.push(t);
        lastTest = t;
      }
      fields = {};
      lastKey = undefined;
      continue;
    }
    const res = RESULT_RE.exec(line);
    if (res) {
      summary = {
        run: Number(res[1]),
        fail: Number(res[2]),
        error: Number(res[3]),
        pass: Number(res[4]),
        ignore: Number(res[5] ?? 0),
      };
      continue;
    }
    const reportCode = REPORT_CODE_RE.exec(line);
    if (reportCode) {
      result.reportCode = Number(reportCode[1]);
      continue;
    }
    const finished = FINISHED_CODE_RE.exec(line);
    if (finished) {
      result.resultCode = Number(finished[1]);
      continue;
    }
    const msg = FINISHED_MSG_RE.exec(line);
    if (msg) {
      result.resultMessage = msg[1]!.trim();
      continue;
    }
    if (line.trim().startsWith('{"suites":')) {
      result.dryRun = parseDryRun(line.trim());
      continue;
    }
    if (line.trim() === '') {
      lastKey = undefined;
      continue;
    }
    // A stack frame (or any other continuation) of the field printed last.
    if (lastKey && fields[lastKey] !== undefined && !line.startsWith('OHOS_') && !line.startsWith('TestFinished')) {
      fields[lastKey] += `\n${line}`;
    }
  }

  return {
    tests,
    summary: summary ?? countSummary(tests),
    summaryReported: summary !== undefined,
    ...result,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `{"suites":[{"Suite":[{"itName":"a"},…]},…]}` → flat list. */
function parseDryRun(json: string): Array<{ suite: string; name: string }> | undefined {
  try {
    const parsed = JSON.parse(json) as { suites?: Array<Record<string, Array<{ itName?: string }>>> };
    return (parsed.suites ?? []).flatMap((s) =>
      Object.entries(s).flatMap(([suite, cases]) => cases.map((c) => ({ suite, name: c.itName ?? '' }))),
    );
  } catch {
    return undefined;
  }
}
