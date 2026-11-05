---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- New `check arkts [project-dir]`: the SDK's own ArkTS type check and linter (what the build's `CompileArkTS` runs),
  plus the ArkUI component-model and project rules hvigor enforces later in a build, in seconds and without hvigor,
  a device or codelinter. It checks against the SDK the project compiles with (`compileSdkVersion`, or the HarmonyOS
  SDK for a HarmonyOS project). `--files` checks only the files given, `--fix` applies the fixes it can verify and
  reverts any that adds an error, `--json` prints `ok`, `completed`, `diagnostics` (the `build --json` shape, with
  `source: "arkts-check"`), `fixed` and `summary`. Exits 0 when clean, 1 on an error, 2 when the checker could not
  run. The checker is deveco-cli's `arkts-check.cjs` (MIT), adapted to take the SDK directory.
- `lint --engine arkts` runs `check arkts`.
- `lint` exits 2 when codelinter reports that its run was incomplete (for example with command-line tools of the
  other flavour), since a clean report then says nothing; `--allow-incomplete` restores exit 0.
- Core exports `checkArkts`, `resolveArktsCheckSdk`, `parseArktsCheckOutput` and `arktsCheckerScript`, and ships
  `vendor/deveco-cli/`.
