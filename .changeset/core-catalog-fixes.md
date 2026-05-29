---
"@oniroproject/core": minor
---

SDK/path catalog fixes and two new config keys.

- **`getHvigorwPath` probe-and-fallback**: the project-local `hvigorw` is now used only when its `hvigor/` install is structurally complete (`hvigor/hvigor-wrapper.js` + `hvigor/node_modules`). HMOS-vendored projects (systemui, launcher) ship a local wrapper whose `hvigor/` install is absent and crashes on startup — those now transparently fall back to the cmd-tools `hvigorw`.
- **`getOhpmPath(config)`** added; **`getCmdToolsBin(config, name = 'ohpm')`** generalized to resolve any cmd-tools binary (`hvigorw`, `codelinter`, …). Non-breaking: the 1-arg form still returns the ohpm path.
- **`ALL_SDKS`** gains API 19 (5.1.1) and a per-OS `tarballStrip` table on `SdkRelease`; `getSdkFilename` now reads strip counts from that table (single source of truth) instead of a hard-coded version list. Behavior is unchanged for all known versions; unrecognized versions keep the historical 1/3 default.
- **New config keys**: `sdkUrlBase` (defaults to the Huawei mirror `OHOS_URL_BASE`; lets a private/CI mirror be used for SDK downloads) and `applicationCertPath` (optional override for the bundled application cert chain during signing). The CLI exposes these as `ONIRO_SDK_URL_BASE` / `ONIRO_APPLICATION_CERT_PATH`.
- **`isEmulatorInstalled`** now detects `images/run.sh` **or** `images/run.bat`, so a Windows-only emulator build is recognized.
