import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where a diagnostic comes from: the ArkTS compiler, hvigor itself (configuration
 * and task errors), the native toolchain (clang, lld), ohpm, the SDK the project
 * compiles against, the signing material (a signingConfig for the other runtime),
 * or `check arkts`.
 */
export type DiagnosticSource = 'arkts' | 'hvigor' | 'native' | 'ohpm' | 'sdk' | 'signing' | 'arkts-check';

/** One error or warning, in a shape shared by `build --json` and `check arkts --json`. */
export interface BuildDiagnostic {
  severity: 'error' | 'warning';
  source: DiagnosticSource;
  /** The tool's code: eight digits for hvigor, ArkTS and ohpm (e.g. `10605008`). */
  code?: string;
  /** The ArkTS linter rule, e.g. `arkts-no-any-unknown`. */
  rule?: string;
  message: string;
  /** Relative to the project root when the file lies inside it, else absolute. */
  file?: string;
  line?: number;
  column?: number;
  /** The hvigor task that reported it, e.g. `:entry:default@CompileArkTS`. */
  task?: string;
  /** For `sdk` diagnostics: the API level the build needs. */
  api?: string;
}

export interface ParsedBuildOutput {
  /** The first hvigor task reported as failed. */
  failedTask?: string;
  diagnostics: BuildDiagnostic[];
  /** hvigor's own `COMPILE RESULT` counts. They can exceed the distinct diagnostics, so are a cross-check only. */
  reportedErrors?: number;
  reportedWarnings?: number;
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Build output as plain lines: colour codes stripped and, of a line redrawn with `\r`, its last state. */
export function cleanBuildOutput(output: string): string[] {
  return output
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => (line.split('\r').filter((s) => s.trim() !== '').pop() ?? '').trimEnd());
}

/** The last `n` lines of build output, cleaned. */
export function buildOutputTail(output: string, n = 200): string {
  const lines = cleanBuildOutput(output);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

/** `> hvigor ERROR: ` / `> hvigor WARN: ` and the error class hvigor prefixes a repeated block with. */
const HVIGOR_PREFIX_RE = /^> hvigor (?:ERROR|WARN|INFO):\s?/;
const ERROR_CLASS_PREFIX_RE = /^(?:[A-Z]\w*Error|Error):\s+/;
const FAILED_TASK_RE = /\bFailed (:\S+?)\.\.\./;
/** `1 ERROR: 10605008 ArkTS Compiler Error`, followed by an `Error Message: … At File: …` line. */
const ARKTS_CODED_RE = /^\d+ (ERROR|WARN): (\d{8}) ArkTS Compiler (?:Error|Warning)$/;
/** `3 ERROR: ArkTS:ERROR File: <path>:<line>:<col>` or `WARN: ArkTS:WARN File: …`, message on the following lines. */
const ARKTS_LOCATED_RE = /^(?:\d+ )?(?:ERROR|WARN): ArkTS:(ERROR|WARN) File: (.+):(\d+):(\d+)$/;
/** `1 WARN: ArkTS:WARN: <message>`, with no location. */
const ARKTS_UNLOCATED_RE = /^(?:\d+ )?(ERROR|WARN): ArkTS:(?:ERROR|WARN): (.+)$/;
const MESSAGE_AT_FILE_RE = /^Error Message: (.*?) At File: (.+):(\d+):(\d+)$/;
const COMPILE_RESULT_RE = /COMPILE RESULT:(?:FAIL|PASS) \{ERROR:(\d+)(?: WARN:(\d+))?\}/;
/** `00303060 Configuration Error` or `Error Code: 00308018 Unknown Error`. */
const HVIGOR_CODED_RE = /^(?:Error Code: )?(\d{8}) ([A-Z][\w ]*?(?:Error|Failed|Exception))\s*$/;
/** ohpm: `Error: 00617101 Fetch Pkg Info Failed`, once `ohpm ERROR:` has been printed. */
const OHPM_START_RE = /^ohpm ERROR: /;
const OHPM_CODED_RE = /^Error: (\d{8}) (.+)$/;
const ERROR_MESSAGE_RE = /^Error Message: (.*?)(?: At file: (.+))?$/;
const ORIGINAL_ERROR_RE = /^\s*Original Error: (.+)$/;
/** clang: `<file>:<line>:<col>: error: <message>`. */
const NATIVE_RE = /^(.+?):(\d+):(\d+): (fatal error|error|warning): (.*)$/;
/** lld: `ld.lld: error: undefined symbol: <sym>`, then `>>> referenced by <f>:<l> (<abs>:<l>)`. */
const LLD_RE = /^(?:ld\.lld|ld|lld)(?:\.exe)?: error: (.*)$/;
const LLD_REFERENCED_RE = /^>>> referenced by (\S+?):(\d+)(?: \((.+):(\d+)\))?$/;
/** GNU ld: `<file>:<line>: undefined reference to `<sym>'`. */
const GNU_UNDEFINED_RE = /^(.+?):(\d+): undefined reference to [`'](.+)'$/;
/** The trailing `(rule-id)` of an ArkTS linter message. */
const RULE_SUFFIX_RE = /\s*\(([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\)\s*$/;

/** Warnings that carry no information about the code. */
const NOISE_RE = /^For details about ArkTS syntax errors, see FAQs/;
/** hvigor's generic wrapper around a native build failure; the clang/lld lines say what failed. */
const NATIVE_WRAPPER_CODE = '00308018';

function relativeTo(projectDir: string | undefined, file: string): string {
  if (!projectDir) return file;
  const rel = path.relative(projectDir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
}

function splitRule(message: string): { message: string; rule?: string } {
  const m = RULE_SUFFIX_RE.exec(message);
  return m ? { message: message.slice(0, m.index).trim(), rule: m[1] } : { message: message.trim() };
}

function key(d: BuildDiagnostic): string {
  return [d.source, d.code ?? '', d.file ?? '', d.line ?? '', d.column ?? '', d.message].join('\u0000');
}

/**
 * Parse hvigor build output (stdout and stderr together, ANSI codes and all) into
 * diagnostics. Pure/testable. Understands the ArkTS compiler's coded and located
 * blocks, hvigor's coded configuration and task errors, clang and lld output from
 * a native build, and ohpm's coded errors. hvigor prints the ArkTS block twice, so
 * diagnostics are de-duplicated; `projectDir` makes paths inside it relative.
 */
export function parseBuildOutput(output: string, opts: { projectDir?: string } = {}): ParsedBuildOutput {
  const lines = cleanBuildOutput(output).map((l) => l.replace(HVIGOR_PREFIX_RE, ''));
  const diagnostics: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  let failedTask: string | undefined;
  let currentTask: string | undefined;
  let reportedErrors: number | undefined;
  let reportedWarnings: number | undefined;
  let inOhpm = false;

  const push = (d: BuildDiagnostic): void => {
    if (d.file) d.file = relativeTo(opts.projectDir, d.file);
    if (currentTask && d.source !== 'ohpm') d.task = currentTask;
    const k = key(d);
    if (seen.has(k)) return;
    seen.add(k);
    diagnostics.push(d);
  };
  /** The message lines after index `i`, up to a blank line or the next block. */
  const messageAfter = (i: number): { text: string; end: number } => {
    const parts: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!.trim();
      if (!l || l.startsWith('* Try')) break;
      if (ARKTS_CODED_RE.test(l) || ARKTS_LOCATED_RE.test(l) || COMPILE_RESULT_RE.test(l)) break;
      parts.push(l);
    }
    return { text: parts.join(' '), end: j - 1 };
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    // A repeated block is prefixed with its error class (`Error: `, `AdaptorError: `).
    const line = raw.replace(ERROR_CLASS_PREFIX_RE, '');
    if (!line) continue;

    const failed = FAILED_TASK_RE.exec(line);
    if (failed) {
      failedTask ??= failed[1];
      currentTask = failed[1];
      continue;
    }

    const result = COMPILE_RESULT_RE.exec(line);
    if (result) {
      reportedErrors = Math.max(reportedErrors ?? 0, Number(result[1]));
      if (result[2] !== undefined) reportedWarnings = Math.max(reportedWarnings ?? 0, Number(result[2]));
      continue;
    }

    const coded = ARKTS_CODED_RE.exec(line);
    if (coded) {
      const next = lines[i + 1]?.trim() ?? '';
      const at = MESSAGE_AT_FILE_RE.exec(next);
      const severity = coded[1] === 'WARN' ? 'warning' : 'error';
      if (at) {
        i++;
        push({
          severity,
          source: 'arkts',
          code: coded[2],
          ...splitRule(at[1]!),
          file: at[2],
          line: Number(at[3]),
          column: Number(at[4]),
        });
      } else {
        const msg = messageAfter(i);
        i = msg.end;
        push({ severity, source: 'arkts', code: coded[2], ...splitRule(msg.text.replace(/^Error Message:\s*/, '')) });
      }
      continue;
    }

    const located = ARKTS_LOCATED_RE.exec(line);
    if (located) {
      // Either ` <message>` or ` ERROR Code: <code> ArkTS: ERROR` + `Error Message: <message>`.
      const msg = messageAfter(i);
      i = msg.end;
      const codeMatch = /ERROR Code: (\d{8})/.exec(msg.text);
      const text = msg.text.replace(/^.*?ERROR Code: \d{8} ArkTS: (?:ERROR|WARN)\s*/, '').replace(/^Error Message:\s*/, '');
      push({
        severity: located[1] === 'WARN' ? 'warning' : 'error',
        source: 'arkts',
        ...(codeMatch ? { code: codeMatch[1] } : {}),
        ...splitRule(text),
        file: located[2],
        line: Number(located[3]),
        column: Number(located[4]),
      });
      continue;
    }

    const unlocated = ARKTS_UNLOCATED_RE.exec(line);
    if (unlocated) {
      if (!NOISE_RE.test(unlocated[2]!)) {
        push({ severity: unlocated[1] === 'WARN' ? 'warning' : 'error', source: 'arkts', ...splitRule(unlocated[2]!) });
      }
      continue;
    }

    if (OHPM_START_RE.test(raw)) {
      inOhpm = true;
      continue;
    }
    const ohpm = inOhpm ? OHPM_CODED_RE.exec(raw) : null;
    if (ohpm) {
      let message = ohpm[2]!.trim();
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const em = ERROR_MESSAGE_RE.exec(lines[j]!.trim());
        if (em) message = `${message}: ${em[1]}`;
        const orig = ORIGINAL_ERROR_RE.exec(lines[j]!);
        if (orig) message = `${message} (${orig[1]!.trim()})`;
      }
      push({ severity: 'error', source: 'ohpm', code: ohpm[1], message });
      inOhpm = false;
      continue;
    }

    const hv = HVIGOR_CODED_RE.exec(line);
    if (hv) {
      const next = lines[i + 1]?.trim() ?? '';
      const em = ERROR_MESSAGE_RE.exec(next);
      const message = em ? em[1]! : next || hv[2]!;
      const d: BuildDiagnostic = { severity: 'error', source: 'hvigor', code: hv[1], message: `${hv[2]}: ${message}` };
      if (em?.[2]) d.file = em[2].trim();
      push(d);
      continue;
    }

    const lld = LLD_RE.exec(line);
    if (lld) {
      const undefinedSym = /^undefined symbol: (.+)$/.exec(lld[1]!);
      const ref = LLD_REFERENCED_RE.exec(lines[i + 1]?.trim() ?? '');
      const d: BuildDiagnostic = {
        severity: 'error',
        source: 'native',
        message: undefinedSym ? `undefined symbol: ${undefinedSym[1]}` : lld[1]!,
      };
      if (ref) {
        d.file = ref[3] ?? ref[1];
        d.line = Number(ref[4] ?? ref[2]);
      }
      push(d);
      continue;
    }

    const gnu = GNU_UNDEFINED_RE.exec(line);
    if (gnu) {
      push({ severity: 'error', source: 'native', message: `undefined symbol: ${gnu[3]}`, file: gnu[1], line: Number(gnu[2]) });
      continue;
    }

    const native = NATIVE_RE.exec(line);
    if (native) {
      push({
        severity: native[4] === 'warning' ? 'warning' : 'error',
        source: 'native',
        message: native[5]!.trim(),
        file: native[1],
        line: Number(native[2]),
        column: Number(native[3]),
      });
      continue;
    }
  }

  // hvigor's own "unknown error" around a failed native build adds nothing once
  // the compiler or linker lines are known.
  const hasNative = diagnostics.some((d) => d.source === 'native' && d.severity === 'error');
  const result: ParsedBuildOutput = {
    diagnostics: hasNative
      ? diagnostics.filter((d) => !(d.source === 'hvigor' && d.code === NATIVE_WRAPPER_CODE))
      : diagnostics,
  };
  if (failedTask) result.failedTask = failedTask;
  if (reportedErrors !== undefined) result.reportedErrors = reportedErrors;
  if (reportedWarnings !== undefined) result.reportedWarnings = reportedWarnings;
  return result;
}

/** A symbol the compiler says a kit or `@ohos.*` module does not export. */
export interface MissingSdkSymbol {
  symbol: string;
  module: string;
}

const MISSING_SYMBOL_RES: RegExp[] = [
  /'([\w$]+)' is not exported from Kit '(@kit\.[\w.]+)'/,
  /'"(@(?:kit|ohos)\.[\w.]+)"' has no exported member named '([\w$]+)'/,
  /Module '"(@(?:kit|ohos)\.[\w.]+)"' has no exported member '([\w$]+)'/,
];

/** The kit/`@ohos` symbols that diagnostics report missing, de-duplicated. Pure. */
export function missingSdkSymbols(diagnostics: readonly BuildDiagnostic[]): MissingSdkSymbol[] {
  const found = new Map<string, MissingSdkSymbol>();
  for (const d of diagnostics) {
    if (d.source !== 'arkts' && d.source !== 'arkts-check') continue;
    for (const [n, re] of MISSING_SYMBOL_RES.entries()) {
      const m = re.exec(d.message);
      if (!m) continue;
      const entry = n === 0 ? { symbol: m[1]!, module: m[2]! } : { symbol: m[2]!, module: m[1]! };
      found.set(`${entry.module}\u0000${entry.symbol}`, entry);
    }
  }
  return [...found.values()];
}

/** The declaration file of a kit or `@ohos` module in an SDK API folder. */
function moduleDeclarationFile(apiDir: string, module: string): string {
  return module.startsWith('@kit.')
    ? path.join(apiDir, 'ets', 'kits', `${module}.d.ts`)
    : path.join(apiDir, 'ets', 'api', `${module}.d.ts`);
}

/**
 * When the build failed on kit or `@ohos` symbols that a newer installed SDK
 * declares, one `sdk` diagnostic naming the API level that has them all (#22);
 * otherwise null. `sdkHome` holds one folder per API level; `projectApi` is the
 * project's compileSdkVersion. Best effort: it reads declaration files and does
 * not know about SDKs that are not installed.
 */
export function sdkTooOldDiagnostic(
  diagnostics: readonly BuildDiagnostic[],
  sdkHome: string,
  projectApi: number | undefined,
): BuildDiagnostic | null {
  const missing = missingSdkSymbols(diagnostics);
  if (missing.length === 0) return null;
  let apis: number[];
  try {
    apis = fs
      .readdirSync(sdkHome)
      .filter((n) => /^\d+$/.test(n))
      .map(Number)
      .filter((n) => projectApi === undefined || n > projectApi)
      .sort((a, b) => a - b);
  } catch {
    return null;
  }
  const cache = new Map<string, string | null>();
  const declares = (api: number, s: MissingSdkSymbol): boolean => {
    const file = moduleDeclarationFile(path.join(sdkHome, String(api)), s.module);
    if (!cache.has(file)) {
      try {
        cache.set(file, fs.readFileSync(file, 'utf8'));
      } catch {
        cache.set(file, null);
      }
    }
    const text = cache.get(file);
    return !!text && new RegExp(`\\b${s.symbol.replace(/\$/g, '\\$')}\\b`).test(text);
  };
  const api = apis.find((a) => missing.every((s) => declares(a, s)));
  if (api === undefined) return null;
  const names = missing.map((s) => `${s.symbol} (${s.module})`).join(', ');
  return {
    severity: 'error',
    source: 'sdk',
    api: String(api),
    message:
      `${names} ${missing.length === 1 ? 'is' : 'are'} not in API ${projectApi ?? '?'}, which the project compiles ` +
      `against, but the installed API ${api} SDK declares ${missing.length === 1 ? 'it' : 'them'}. Raise ` +
      `compileSdkVersion and compatibleSdkVersion in build-profile.json5 to ${api} (and targetSdkVersion, if set), ` +
      'or stop using the newer API.',
  };
}

/** Compiler messages that a symbol an SDK lacks produces: a missing property or name. */
const MISSING_API_RE = /\bProperty '[^']+' does not exist on type\b|\bCannot find name '[^']+'/;
const OH_MODULES_RE = /(?:^|[\\/])oh_modules[\\/]/;

/**
 * The package an `oh_modules/` path belongs to, e.g. `@ohos/flutter_ohos` for
 * `oh_modules/.ohpm/@ohos+flutter_ohos@1.0.0/oh_modules/@ohos/flutter_ohos/src/…`.
 */
export function ohModulesPackage(file: string): string | undefined {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('oh_modules');
  if (at < 0) return undefined;
  const first = parts[at + 1];
  if (!first) return undefined;
  if (first === '.ohpm') {
    // `.ohpm/@scope+name@version…`: the store entry, when no nested oh_modules follows.
    const entry = parts[at + 2];
    const m = entry ? /^(@?[^@]+)@/.exec(entry) : null;
    return m ? m[1]!.replace('+', '/') : undefined;
  }
  return first.startsWith('@') && parts[at + 2] ? `${first}/${parts[at + 2]}` : first;
}

/**
 * A hint when the ArkTS errors are missing properties or names inside
 * `oh_modules/`: a dependency calling an API newer than the SDK the build used
 * (#22). Message-level only; it does not read the dependencies. `sdkLabel` names
 * that SDK (`HarmonyOS 5.1.0 (API 18) at …`) and `remedy` how to get a newer one.
 * Null when no such error is there.
 */
export function dependencyApiDiagnostic(
  diagnostics: readonly BuildDiagnostic[],
  sdkLabel: string | undefined,
  remedy: string,
): BuildDiagnostic | null {
  const hits = diagnostics.filter(
    (d) =>
      d.severity === 'error' &&
      d.source === 'arkts' &&
      !!d.file &&
      OH_MODULES_RE.test(d.file) &&
      MISSING_API_RE.test(d.message),
  );
  if (hits.length === 0) return null;
  const packages = [...new Set(hits.map((d) => ohModulesPackage(d.file!)).filter((p): p is string => !!p))];
  const where = packages.length ? `dependencies (${packages.join(', ')})` : 'dependencies under oh_modules/';
  return {
    severity: 'warning',
    source: 'sdk',
    message:
      `${hits.length} error${hits.length === 1 ? '' : 's'} in ${where} report${hits.length === 1 ? 's' : ''} a ` +
      `property or name the SDK does not declare${sdkLabel ? `; the build used ${sdkLabel}` : ''}. A dependency ` +
      `may need a newer API level: ${remedy}`,
  };
}
