# @oniroproject/oniro-app

## 0.14.0

### Minor Changes

- bb57ec8: Fix device targeting, catch failures hdc reports as success, and fill gaps found while evaluating a batch of apps on two targets.

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

### Patch Changes

- Updated dependencies [bb57ec8]
  - @oniroproject/core@0.14.0

## 0.13.0

### Minor Changes

- 8fe78e6: Make driving the UI from an agent less error-prone.

  - `oniro-app dump layout --flat` prints one line per labelled or interactive element
    (type, label, `#id`, center as 0–1 fractions, flags), grouped by window, with the
    soft keyboard collapsed to one line. The JSON output stays the default.
  - The pruned layout now reports placeholder text (`hint`), `disabled` components, and
    `covered` elements, meaning those painted over by a later layer with a visible
    background (a dialog scrim, an overlay, the keyboard). With keyboard detection it
    also carries `keyboard: { shown, bundle, b }`.
  - `oniro-app input` can act on an element by label with `--target` (plus
    `--target-id`, `--target-type` and `--target-index`), or take a position as 0–1
    fractions with `--fx`/`--fy`/`--fx2`/`--fy2`.
    - Covered elements are skipped and clickable ones are preferred. An ambiguous match
      fails and lists the candidates.
    - When the soft keyboard hides the element, it is dismissed first.
  - New input types:
    - `clearText` clears a field with Ctrl+A then Delete.
    - `hideKeyboard` presses Back only when the keyboard is shown.
  - `inputText` gains `--clear`, and any action can take `--hide-keyboard`.
  - `--key` accepts named keys (`Delete`, `Enter`, `Tab`, `Escape`, `MoveHome`, …),
    letters, and combos of up to three keys such as `Ctrl+A`.
  - `oniro-app wait --target <text> [--gone]` waits for an element to appear or
    disappear.
  - `oniro-app screenshot --crop x1,y1,x2,y2` and `--target <text>` write a
    full-resolution crop of one region or element.
  - `oniro-app gesture --fractions` takes waypoints as 0–1 fractions.
  - Core exports `performInput`, `locateTarget`, `hideKeyboard`, `waitForTarget`,
    `flattenLayout`, `findLayoutNodes`, `pickTarget`, `findCoveredNodes`,
    `resolveKeyEvent`, and the IME helpers.

### Patch Changes

- Updated dependencies [8fe78e6]
  - @oniroproject/core@0.13.0

## 0.12.0

### Minor Changes

- 0363671: Add OpenHarmony 7.0 (API 26) to the known SDKs, so `oniro-app sdk list` shows it and
  `oniro-app sdk install 7.0` downloads it.

  The mirror re-published 7.0 under dated archive names (`…_20260829.tar.gz`); the
  undated archives hold `-Beta` components. `SdkRelease` gains an optional
  `archiveSuffix`, which `getSdkFilename` appends to the archive basename, and 7.0 uses
  it to fetch the `-Release` build.

### Patch Changes

- 838a2a5: Recover the hdc connection to a TCP device (e.g. the emulator) that wedges after a
  reboot. The hdc server can keep the old session "Connected": `hdc tconn` answers
  "Target is connected, repeat operation" and every command fails until the server is
  restarted, so `oniro-app reboot --wait-bundle` and `oniro-app wait` timed out. The
  post-reboot waits now restart the hdc server (`hdc start -r`) and reconnect when tconn
  claims a connection the device does not answer on three polls in a row.
- Updated dependencies [838a2a5]
- Updated dependencies [0363671]
  - @oniroproject/core@0.12.0

## 0.11.0

### Minor Changes

- ee2715c: Add HarmonyOS support alongside OpenHarmony.

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

### Patch Changes

- Updated dependencies [ee2715c]
  - @oniroproject/core@0.11.0

## 0.10.0

### Minor Changes

- 73a11d5: Add device targeting to app installation. `installApp` now accepts `deviceSerial`, and `oniro-app app install` exposes it as `--device <serial>`.

### Patch Changes

- Updated dependencies [73a11d5]
  - @oniroproject/core@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [67b2d62]
  - @oniroproject/core@0.9.0

## 0.9.0

### Minor Changes

- 78de405: Keep install temporaries off `/tmp`, and explain it when they run out of room.

  `sdk install`, `cmdtools install`, and `emulator install` downloaded a multi-GB archive and
  extracted it in a scratch directory under the system temp dir. On most Linux systems `/tmp` is a
  RAM-backed `tmpfs` sized from available memory, so machines with plenty of disk but little free
  RAM could not install the SDK or the command-line tools at all.

  - **The scratch directory now lives next to the install target** — `.oniro-tmp` beside the SDK
    root, the command-line-tools directory, or the emulator directory. That keeps a RAM-backed
    system temp dir out of the picture, and since temporaries and their destination now share a
    filesystem, finishing an install is a rename instead of a multi-GB cross-device copy. When the
    install target's parent cannot be written to (a root-owned prefix, a read-only mount), the
    system temp dir is used instead and a warning says so.
  - **`--tmp-dir <path>` on all three install commands**, plus the `ONIRO_TMP_DIR` environment
    variable (`tmpDir` config key). Precedence: flag → env → `<install root>/.oniro-tmp`. A
    directory named explicitly is never swapped out silently.
  - **Fail before downloading** when the advertised `content-length` does not fit in the scratch
    directory's free space, so nothing is written when it cannot fit.
  - **Clear errors instead of a crash.** A write failure during the download had no handler, so an
    out-of-space filesystem surfaced as an unhandled `ENOSPC` event that killed the process.
    Out-of-space failures anywhere in an install now raise `InsufficientSpaceError`, naming the
    directory, how much room was needed versus available, whether that directory is RAM-backed
    (`tmpfs`), and the `--tmp-dir` / `ONIRO_TMP_DIR` remedy.

  New in `@oniroproject/core`: `InsufficientSpaceError` and the temp-space helpers in `sdk/tmp.ts`
  (`createInstallTempDir`, `removeTempWorkDir`, `resolveTmpRoot`, `createTempWorkDir`,
  `getFreeSpaceBytes`, `isRamBackedPath`, `ensureFreeSpace`, `isOutOfSpaceError`, `toSpaceError`,
  `formatBytes`, `INSTALL_TMP_DIRNAME`, `TMP_DIR_HINT`). `downloadFile` gains `what` and `tmpRoot`
  options; the three install option objects gain `tmpDir`. Downstream frontends need no changes —
  the new `tmpDir` config key is optional, and a `ConfigProvider` that does not know it just returns
  the fallback.

### Patch Changes

- Updated dependencies [78de405]
  - @oniroproject/core@0.8.0

## 0.8.1

### Patch Changes

- b307540: Two `app apply` / device-process fixes, both surfaced while deploying an app whose code
  runs in an **extension-ability** process:

  - **`app apply`: make `--bundle` optional.** When omitted it now auto-resolves the bundle
    name from the project's `AppScope/app.json5`, matching how `app launch` and `build`
    already discover the bundle/ability. Previously `--bundle` was required, inconsistent with
    the rest of the device commands.

  - **Detect extension-ability processes when checking "is the bundle running".**
    `findRunningProcess` matched only the bundle's main (UIAbility) process via
    `pidof '<bundle>'`. Apps whose only live process is an extension ability — ServiceExtension,
    FormExtension, UIExtension, input method, etc. — run under a separate process name
    `"<bundle>:<ext>"` and were reported as not running (so `app apply` printed `pid - -> -`
    and the wait/log helpers couldn't find them). It now falls back to `track-jpid` and matches
    `"<bundle>"`, `"<bundle>/…"`, or `"<bundle>:…"`. This makes the apply pre/post-pid check,
    `wait --bundle`, and hilog pid filtering work for extension-hosted apps.

## 0.8.0

### Minor Changes

- e9e80fe: Add a `NativeCpp` project template — an ArkTS + Native C++ (N-API) starter with a CMake-built native library. Selectable via `oniro-app create --template NativeCpp` and listed by `oniro-app templates list`.

## 0.7.0

### Minor Changes

- 189b878: Expose the new core device/build/install/signing surface as CLI subcommands.

  New commands: `reboot`, `wait` (`--log`/`--boot`/`--bundle`), `watch --log`, `screenshot [--burst]`, `dump [layout]`, `devices`, `file send`/`file recv`, `lint`, `input`, and `gesture`. The `app` command gains `apply` (verified install with sign-info/asset-cache/restart handling), `uninstall`, and `stop`, and `app launch` gains `--ability`. `sign` gains `--bootstrap` (no-op when signing material is present, else generate) plus `--store-password`/`--key-password`.

  `build` now runs the `buildHap` orchestrator (auto `ohpm install --all` when `oh_modules/` is missing, then build, then HAP discovery) and **builds in parallel by default** — pass `--no-parallel` to restore serial builds, `--no-deps` to skip the ohpm step, and `--json` to emit the discovered HAPs.

  Read/observe commands (`devices`, `dump`, `wait --log`, `watch`, `lint`, `app apply`) support `--json` on stdout; logs/progress stay on stderr. Requires `@oniroproject/core@^0.7.0`.

- 3e728db: `oniro-app screenshot` now does the agent-facing image processing itself (moved out of the ohos-hdc MCP).

  - **`--grid`** downscales to `--max-dim` (longest side, default 1024) and overlays a 10x10 grid with 0.0–1.0 axis labels for picking tap coordinates — equivalent to the old MCP `screenshot`. `--max-dim` on its own downscales without the grid.
  - **`--contact-sheet`** captures a burst (default 8 frames at `--interval`; pass `--burst N` to change the count) and composites it into a single tiled image with per-frame index labels, writing **per-frame change diffs (0..1)** to stdout (`--json` for the full object) so you can spot the frame where something changed. One image replaces N — a large token saving when verifying transient UI (gestures, animations, boot).

  A plain `oniro-app screenshot` still writes the full-resolution raw JPEG (unchanged). Adds `sharp` as a CLI dependency (kept external in the tsup build); `@oniroproject/core` stays image-dependency-free.

### Patch Changes

- Updated dependencies [29958f8]
- Updated dependencies [16114d8]
- Updated dependencies [03f0a89]
- Updated dependencies [e4c328a]
- Updated dependencies [a54a857]
- Updated dependencies [e117386]
- Updated dependencies [e4c328a]
- Updated dependencies [eb63f30]
- Updated dependencies [ac9fa01]
- Updated dependencies [b89b46f]
- Updated dependencies [637fff5]
  - @oniroproject/core@0.7.0

## 0.6.2

### Patch Changes

- Fix signing of apps that request privileged (system_basic/system_core) permissions.

  - Route system*basic/system_core through the OpenHarmony **Application Release** key/cert chain (BMS rejects HAPs signed with the SDK's \_Profile* Release cert once an apl-elevated permission is requested).
  - New `--acls <list>` flag on `oniro-app sign` to populate the profile's `acls.allowed-acls`; omitting it leaves the existing template value untouched (`apl=normal` default unchanged).
  - `updateBuildProfile()` now preserves per-product `signingConfig` names from `build-profile.json5` instead of forcing `"default"`, so system-app source trees (e.g. `systemui` using `signingConfig: "release"`) work without manual renaming.

- Updated dependencies
  - @oniroproject/core@0.6.2

## 0.6.1

### Patch Changes

- a7a4437: Add a package README so each npm landing page shows install and usage info instead of "no readme data". No code changes.
- Updated dependencies [a7a4437]
  - @oniroproject/core@0.6.1

## 0.6.0

### Minor Changes

- 9ed025e: First npm release of the rewritten cross-platform Node monorepo.

  - Replaces the `.deb`-only bash CLI with `@oniroproject/core` (library) and `@oniroproject/oniro-app` (CLI), runnable on Linux, macOS, and Windows.
  - Adds emulator launcher + reusable CI workflow, hilog streaming with buffer-level + line parser, and `--apl/--app-feature` flags for signing system-permission apps.

### Patch Changes

- Updated dependencies [9ed025e]
  - @oniroproject/core@0.6.0
