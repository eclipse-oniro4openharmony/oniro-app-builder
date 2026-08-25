---
'@oniroproject/core': minor
---

Fix `spawn EINVAL` on Windows when running `build`, `lint` or `cmdtools status`.

The OpenHarmony command-line tools ship as batch wrappers on Windows
(`ohpm.bat`, `hvigorw.bat`, `codelinter.bat`), and since the fix for
CVE-2024-27980 (Node 18.20.2 / 20.12.2 / 21.7.3 and later) `spawn()` refuses to
execute a `.bat`/`.cmd` file without a shell — it throws a bare
`Error: spawn EINVAL`. Every Windows build failed at the first `ohpm install`.

`runProcess` and `runHvigorw` now route batch wrappers through
`cmd.exe /d /s /c` with each argument individually escaped, so arguments are
still never word-split; arguments carrying a quote, newline or NUL are rejected
rather than passed through mangled. Related fixes in the same area:

- `getHvigorwPath` no longer prefers a project's extensionless POSIX `hvigorw`
  script on Windows — `hvigorw.bat`/`.cmd` come first there.
- Synchronous `spawn()` failures are reported as `Failed to spawn <command>: …`
  instead of escaping as a bare OS error, and a missing wrapper is still
  reported as a spawn failure rather than a `cmd.exe` exit code.
- Aborted or timed-out commands are killed with `taskkill /T /F` on Windows, so
  the process the wrapper launched dies with it.
- The three streaming `hdc` call sites (`listRunningProcesses`, `streamHilog`,
  `setHilogLevel`) spawn hdc directly rather than through `runProcess`, and got
  the same treatment: `getHdcPath` resolves `hdc.bat`/`hdc.cmd`, and an
  `hdcPath` override pointed at a proxy/tunnel wrapper is a documented setup.
- `waitForLog` and `watchLog` now reject when the device lookup or the spawn
  fails, instead of raising an unhandled rejection and quietly running to their
  deadline.
- `buildHap` and `runHvigorw` expand a Windows 8.3 short project path (the form
  `%TEMP%` and `cmd`-built paths often take) to its long form first. hvigor
  cannot resolve a module `srcPath` underneath a short path and aborts with
  `00303149 Configuration Error / Path not found` naming a directory that
  plainly exists; discovered HAP paths now come back in long form too.
