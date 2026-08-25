import * as path from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { OniroError } from '../ports/errors.js';

/**
 * Windows batch wrappers (`.bat` / `.cmd`) cannot be executed by
 * `CreateProcess` — they are scripts interpreted by `cmd.exe`. Node used to
 * paper over that by silently prepending `cmd.exe /c`, but the fix for
 * CVE-2024-27980 (Node 18.20.2 / 20.12.2 / 21.7.3 and later) removed the
 * implicit shell: `spawn('foo.cmd', args)` with `shell: false` now throws a
 * bare `Error: spawn EINVAL`.
 *
 * That matters here because the OpenHarmony command-line tools ship as batch
 * wrappers on Windows (`ohpm.bat`, `hvigorw.bat`, `codelinter.bat`), so every
 * build and lint invocation hit that throw.
 *
 * We therefore invoke `cmd.exe /d /s /c "<command> <args...>"` explicitly.
 * Doing it ourselves — rather than passing `shell: true` — is what preserves
 * the "arguments are never word-split" guarantee the rest of this package
 * relies on: `shell: true` hands `cmd.exe` the raw, unescaped join of command
 * and args, reintroducing exactly the injection surface `runProcess` exists to
 * avoid. The escaping below follows https://qntm.org/cmd (the same algorithm
 * `cross-spawn` uses).
 */

const WINDOWS_BATCH_RE = /\.(bat|cmd)$/i;

/** Characters `cmd.exe` treats specially, including whitespace. */
const CMD_META_RE = /([()[\]%!^"`<>&|;, *?])/g;

/**
 * npm-style shims (`node_modules/.bin/foo.cmd`) forward their arguments with a
 * bare `%*`, so the command line is parsed a second time inside the shim and
 * metacharacters need a second layer of escaping. Ordinary wrappers must NOT
 * be double-escaped — the surplus carets would end up in the argument values.
 */
const CMD_SHIM_RE = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/**
 * Characters that cannot be passed through `cmd.exe` without ambiguity.
 *
 * The OpenHarmony wrappers end in `call "<inner>\tool.bat" %*`, and the inner
 * script forwards the same `%*` to node — so every argument is re-parsed by
 * `cmd.exe` twice more after we hand off the command line. Quoting is what
 * survives those hops: metacharacters inside a quoted token stay inert no
 * matter how many times the line is re-parsed.
 *
 * A double quote is the one thing that breaks that. `cmd.exe` has no `\"`
 * escape — it simply toggles quote state on every `"` — so an embedded quote
 * ends the quoted region early and everything after it is re-parsed as
 * command syntax. Newlines and NULs cannot be carried at all. None of the
 * tools invoked here need any of them, so we refuse loudly rather than pass
 * something subtly different from what the caller asked for.
 *
 * Known remaining edge: the wrappers run under `setlocal enabledelayedexpansion`,
 * so a literal `!` in an argument is subject to delayed expansion. It can
 * corrupt a value but not execute anything, and no argument this package builds
 * contains one.
 */
const UNSAFE_CMD_CHARS_RE = /["\r\n\0]/;

/**
 * True when `command` must be routed through `cmd.exe` to run at all —
 * i.e. we are on Windows and the target is a batch wrapper.
 *
 * `platform` is injectable so the behaviour is unit-testable off Windows.
 */
export function needsCmdWrapper(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && WINDOWS_BATCH_RE.test(command);
}

/**
 * Escape one argument for a `cmd.exe` command line: quote it, double the
 * backslashes that would otherwise escape the closing quote, then caret-escape
 * every metacharacter.
 *
 * `doubleEscapeMetaChars` adds the second caret layer needed by `%*`-forwarding
 * shims — see {@link CMD_SHIM_RE}.
 */
export function escapeCmdArgument(arg: string, doubleEscapeMetaChars = false): string {
  let out = String(arg);
  // Backslashes preceding a quote are doubled, and the quote itself escaped.
  out = out.replace(/(\\*)"/g, '$1$1\\"');
  // Trailing backslashes are doubled so they don't escape our closing quote.
  out = out.replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(CMD_META_RE, '^$1');
  if (doubleEscapeMetaChars) out = out.replace(CMD_META_RE, '^$1');
  return out;
}

/**
 * Escape the executable path. It is caret-escaped but deliberately NOT quoted:
 * `cmd.exe /s /c "..."` strips the outer quotes of the whole line, and a quoted
 * first token confuses that parse. Caret-escaping the spaces is what makes
 * `C:\Program Files\...` work.
 */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_RE, '^$1');
}

export interface CmdWrapper {
  command: string;
  args: string[];
}

/**
 * Build the `cmd.exe /d /s /c "<command> <args...>"` invocation for a batch
 * wrapper. Pure (no I/O, no spawning) so the escaping is unit-testable on every
 * platform.
 *
 * `/d` skips AutoRun registry commands, `/s` keeps the outer quotes intact,
 * `/c` runs the command and exits.
 *
 * @throws OniroError if the command or any argument contains a character that
 * cannot survive `cmd.exe` unambiguously (see {@link UNSAFE_CMD_CHARS_RE}).
 */
export function buildCmdWrapper(command: string, args: readonly string[]): CmdWrapper {
  assertCmdSafe(command, `command ${command}`);
  args.forEach((a, i) => assertCmdSafe(a, `argument ${i} (${a})`));

  // Forward slashes in a command path make cmd.exe report "not recognized".
  const normalized = path.normalize(command);
  const double = CMD_SHIM_RE.test(normalized);
  const line = [escapeCmdCommand(normalized), ...args.map((a) => escapeCmdArgument(a, double))].join(' ');
  return {
    command: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
  };
}

function assertCmdSafe(value: string, label: string): void {
  if (UNSAFE_CMD_CHARS_RE.test(value)) {
    throw new OniroError(
      `Cannot run a Windows batch wrapper with a quote, newline or NUL in the ${label}: ` +
        'cmd.exe cannot pass it through unambiguously.',
    );
  }
}

/**
 * `child_process.spawn`, but able to run Windows batch wrappers.
 *
 * Identical to `spawn` everywhere else — on POSIX, and on Windows for real
 * executables, the command and args are passed straight through with
 * `shell: false`.
 */
export function spawnCompat(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (!needsCmdWrapper(command)) {
    return spawn(command, [...args], { ...options, shell: false });
  }
  const wrapped = buildCmdWrapper(command, args);
  return spawn(wrapped.command, wrapped.args, {
    ...options,
    shell: false,
    // The line is already escaped; stop Node from re-quoting it.
    windowsVerbatimArguments: true,
  });
}

/**
 * Kill a child and everything it started.
 *
 * On Windows a signal only reaches the process we spawned — killing the
 * `cmd.exe` wrapper leaves the Node/hvigor process it launched running, so an
 * aborted or timed-out build would keep holding the project's output files.
 * `taskkill /T /F` tears down the whole tree instead.
 */
export function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      // taskkill missing from PATH must not raise an unhandled 'error' event.
      killer.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      });
      return;
    } catch {
      /* fall through to the plain kill below */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}
