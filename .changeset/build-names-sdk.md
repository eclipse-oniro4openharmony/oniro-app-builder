---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- A failed build names the SDK it compiled against, e.g. `Built against HarmonyOS 5.1.0 (API 18) at
  ~/command-line-tools/sdk.`, and `build --json` reports it as `sdk` (`runtimeOS`, `displayName`, `version`, `api`,
  `path`), for a build that passed too (#22).
- When the ArkTS errors are missing properties or names (`Property '…' does not exist on type …`,
  `Cannot find name '…'`) in code under `oh_modules/`, the build adds a `warning` `sdk` diagnostic, also in the
  error. It names the dependency and the SDK and says the dependency may need a newer API level, with how to get
  one: newer command-line tools for HarmonyOS, `sdk install` for OpenHarmony. It reads only the compiler messages.
- Core exports `resolveBuildSdk`, `describeBuildSdk`, `dependencyApiDiagnostic` and `ohModulesPackage`;
  `BuildHapResult`, `BuildReport` and `BuildFailedError` gain `sdk`.
