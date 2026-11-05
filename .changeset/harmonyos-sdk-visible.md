---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- The HarmonyOS SDK is no longer invisible (#21). `cmdtools status` prints what the tools are, e.g.
  `Installed 6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2)`, then the SDK they bundle (name, API level, build,
  path) and the hvigor version; `--json` adds `version`, `sdk` and `tools` (hvigor, ohpm, codelinter, hstack).
- `sdk list` says HarmonyOS SDKs come with the command-line tools (`cmdtools`) or DevEco Studio and lists the one a
  HarmonyOS build would use, with where it came from; `--json` appends it as a `flavour: "HarmonyOS"` entry and marks
  the others `flavour: "OpenHarmony"`.
- The `cmdtools` description says it supplies the HarmonyOS SDK, and "No HarmonyOS SDK found" names
  `oniro-app cmdtools install`.
- Core exports `readCmdToolsInfo`, `describeCmdTools`, `getHarmonyOsSdkListing` and `readSdkPkg`. `CmdToolsStatus`
  gains `version`, `sdk` and `tools`; `HarmonyOsSdk` gains `apiVersion` and `source`.
