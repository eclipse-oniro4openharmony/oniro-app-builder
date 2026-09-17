---
'@oniroproject/core': minor
'@oniroproject/oniro-app': minor
---

Add HarmonyOS support alongside OpenHarmony.

A project is HarmonyOS when its product declares `runtimeOS: "HarmonyOS"` in
`build-profile.json5`, as DevEco Studio writes. Every other project is OpenHarmony
and behaves exactly as before, offline signing included.

- `oniro-app auth login|logout|status|team list` — sign in to a Huawei developer
  account. The token is stored encrypted under `ONIRO_HARMONYOS_AUTH_DIR`.
- `oniro-app sign --harmonyos` — AppGallery Connect issues a debug certificate and
  profile, and the encrypted signingConfig is merged into `build-profile.json5`.
  Still-valid material is reused; `--force` regenerates. No device needs to be
  attached when the team already has devices registered. The certificate is named
  `oniro_debug_<team>.cer`, so it coexists with DevEco Studio's own.
- `oniro-app build` builds HarmonyOS projects against the HarmonyOS SDK
  (`DEVECO_SDK_HOME`), with that install's hvigor and ohpm.
- `oniro-app create --template HarmonyOSApp` scaffolds a HarmonyOS project.
- The HarmonyOS SDK is found in DevEco Studio's default location, at the
  command-line-tools path when those are the HarmonyOS edition, or at
  `ONIRO_HARMONYOS_SDK_PATH`. It cannot be downloaded the way the OpenHarmony SDK
  can, so nothing is fetched.

HarmonyOS signing calls private AppGallery Connect APIs and needs a Huawei developer
account that is real-name verified or has accepted the HUAWEI Developer Basic
Service Agreement. Accounts from every Huawei region work — calls go to the
account's own region, as in DevEco Studio — whereas Huawei's own CLI accepts only
Chinese-mainland accounts. Parts of `packages/core/src/harmonyos/` are adapted from
the MIT-licensed `openharmony-sig/deveco-cli`; see
`packages/core/src/harmonyos/NOTICE.md`.
