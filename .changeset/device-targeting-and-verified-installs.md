---
'@oniroproject/core': minor
'@oniroproject/oniro-app': minor
---

Fix device targeting, catch failures hdc reports as success, and fill gaps found while evaluating a batch of apps on two targets.

Fixes:

- `ONIRO_DEVICE_SERIAL` (and `DEVICE_SERIAL`) is now honoured by every device command. Before, nothing read it,
  so with two targets connected `screenshot`, `dump layout`, `app launch` and `app apply` failed with
  `need connect-key`, including for a TCP serial such as `127.0.0.1:5555`. `--device` still wins. hdc server
  commands (`list targets`, `tconn`, `start`, `kill`) are never addressed from the env var. The streams that
  spawned hdc directly (`hilog`, `track-jpid`) now address the device too.
- hdc exits 0 when it prints `[Fail]…`. Such a line now counts as a failure, and a `need connect-key` error says
  how to pick a device. `ensureOk` reports stdout when stderr is empty.
- `app install` and `app apply` fail when the bundle manager rejects the HAP (`msg:error: failed to install
  bundle`, `code:95xxxxx`), which hdc also reports with exit code 0. `app apply` then checks with `bm dump` that the
  bundle is installed before reporting success.
- `lint` parses codelinter's real report (a `<file>(<count>)` header, then `<line>:<col> <severity> <message>
  <rule>` rows, then a `-Defects: …` summary). Before, every run printed "No findings." and exited 1. It now prints
  the findings and the totals, and exits 1 only on error-severity findings or when codelinter produced no report.
  When codelinter warns that the report is incomplete, `lint` explains why on stderr: the command-line tools'
  flavour does not match the project's `runtimeOS`.
- `build` no longer advises `sign --harmonyos` as the only option for an unsigned HarmonyOS build (the HarmonyOS
  emulator installs unsigned HAPs), and fails early, naming the release to install, when an OpenHarmony
  project's `compileSdkVersion` SDK is missing. `sign` raises the same error.
- `sign` points a product that names no `signingConfig` at the generated one. Before, the build stayed unsigned.
- `paramGet` throws for an unset property instead of returning `Get parameter "…" fail!` as its value.
- `file send` / `file recv` normalise the local path. hdc read a forward-slash Windows path (`C:/Users/…`) as
  relative, and could not resolve an 8.3 short path. A device path that Git Bash already rewrote is rejected
  with a hint to set `MSYS_NO_PATHCONV=1`.

New:

- `devices --long`: OS family and version, API level, CPU ABI, device type, and model of each connected target.
  `getDeviceInfo` reads all of them in one round trip (`paramGetMany`), and adds `osFamily`, `osDistName`,
  `osDistVersion`, `abi`, and `deviceType`.
- `logs -o <file> [--for ms] [--grep re] [--clear]` captures hilog for a whole session, so the small device log
  buffer can no longer drop its start. It writes each line as it arrives and reconnects after a reboot. Core:
  `captureLog`.
- `hdc [args...]` runs the bundled hdc, addressed at `--device` / `ONIRO_DEVICE_SERIAL`; `hdc --path` prints it.
  Global options must now come before the command (`oniro-app --version`).
- `emulator status`: installed, running, and connected, without starting the emulator. Core: `getEmulatorStatus`.
- `cmdtools status` shows the tools' flavour (HarmonyOS or OpenHarmony) and the hdc path. Core:
  `detectCmdToolsFlavour`.
- `app install` takes a `.hap` path as well as a project dir. With no signed HAP, `app install` and `app apply`
  fall back to the unsigned one on any target (`app install` takes the entry module's when several modules have
  one), and a `*-signed.hap` path that does not exist falls back to its `*-unsigned.hap`. When the target refuses
  the unsigned HAP, the error names the bundle manager's reason (e.g. `code 9568320: no signature file`) and the
  `sign` command to run, instead of hdc's raw output. HAPs are now newest first, so a fresh build wins over HAPs
  committed to the repository.
- `file send --bundle <b>` writes into an app's sandbox (relative paths resolve inside it) and chowns the file to
  the app, which cannot read the root-owned files hdc creates.
- `sign --app-privilege-capabilities <list>` writes `app-privilege-capabilities` into the profile, e.g.
  `AllowAppUsePrivilegeExtension`, without which a privileged extension ability fails to install with 9568344.
- `build --install-sdk` installs the missing OpenHarmony SDK and builds. A build that fails on system-API errors
  (`'…' is not exported from Kit '…'`) gets a hint about the full SDK.
- Core also exports `resolveDeviceSerial`, `hdcTargetArgs`, `hdcTargetArgsFor`, `hdcClientFailure`,
  `detectInstallFailure`, `ensureInstallOk`, `installFailureReason`, `unsignedHapRejection`, `isUnsignedHap`,
  `existingHapOrUnsigned`, `isBundleInstalled`, `pickHap`, `parseCodelinterReport`,
  `cleanCodelinterOutput`, `findMissingProjectSdk`, `diagnoseBuildFailure`, `normaliseLocalPath`,
  `assertDevicePath`, and `appSandboxDir`.
