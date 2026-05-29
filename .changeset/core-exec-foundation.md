---
"@oniroproject/core": minor
---

Add a shared command-execution layer and standardize logging/error primitives (foundation for the device-lifecycle, observability, and install surface).

- New `hdc/exec.ts`: `hdcExec`, `shell`, `runProcess`, and `ensureOk`. Commands are spawned with `shell: false` and args passed as an array, so command construction is injection-safe by construction. Resolves `{ code, stdout, stderr }` for any exit code; `ensureOk` opts into throw-on-non-zero. Supports per-call `timeoutMs`, `abortSignal` (rejects `CancelledError`), and an `onOutput` streaming hook.
- New `scopedLogger(logger, scope)` in `ports` — standardizes the ad-hoc `[hdc]`/`[emulator]`/… prefixes.
- New `CommandFailedError` in `ports` — distinguishes "ran and exited non-zero" from "could not spawn".
- Internal: `hdc/app.ts` and `emulator/lifecycle.ts` now use the shared layer; their duplicated `execPromise` helpers are removed. **Fixes a shell-injection risk in `launchApp`**, which previously interpolated the ability/bundle names into a shell string. No public API signatures changed.
