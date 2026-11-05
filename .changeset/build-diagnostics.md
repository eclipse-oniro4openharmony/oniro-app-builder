---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- `build --json` prints one result object whether the build passes or fails (a failed build still exits 1):
  `ok`, `exitCode`, `durationMs`, `failedTask`, `diagnostics`, `summary`, `discoveredHaps`, `warnings`, `error` and
  `rawTail` (the last 200 lines of output, colour codes removed). Each diagnostic has `severity`, `source` (`arkts`,
  `hvigor`, `native`, `ohpm` or `sdk`), `code`, `rule`, `message`, a project-relative `file`, `line`, `column` and the
  hvigor `task`. hvigor prints the ArkTS block twice; each diagnostic is listed once.
- A failed build lists its errors on stderr, one per line, after hvigor's output.
- When the project uses kit symbols its SDK lacks but a newer installed SDK declares, the build names that API level
  in an `sdk` diagnostic and in the error, instead of pointing at the full SDK (#22).
- Core exports `buildWithDiagnostics` (returns `ok: false` instead of throwing for a failed build or a missing SDK),
  `BuildFailedError` (what `buildHap` now throws when ohpm or hvigor fails), `parseBuildOutput`,
  `sdkTooOldDiagnostic` and `missingSdkSymbols`. `BuildHapResult` gains `diagnostics` and `summary`.

Fixes:

- A failed native build no longer gets the hint that hvigor cannot find the SDK: hvigor wraps every native failure
  in its catch-all `00308018 Unknown Error`, which was read as a missing SDK.
