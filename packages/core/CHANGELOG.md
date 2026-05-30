# @oniroproject/core

## 0.7.0

### Minor Changes

- 29958f8: Add install orchestration that verifies the running process took the change.

  - **`install/apply.ts`**: `applyChanges()` installs a HAP and handles the three failure modes a naive "install the most recent signed HAP" deploy ignores:

    1. **sign-info-inconsistent (9568332)** on `hdc install -r` — for a normal app, uninstall + fresh install; for a **system bundle, refuse** (uninstalling it can brick the device) unless `allowUninstall` is set;
    2. **asset-cache invalidation** — when the new HAP's file manifest changed vs the installed one, reboot (the ACE extractor cache is path-keyed and survives a process kill);
    3. **persistent-bundle restart** — when a system bundle's pid didn't change after install, reboot.

    Multi-module projects resolve the right HAP via `discoverHaps` (errors on ambiguity instead of installing the wrong module). The branch logic is exported as pure, tested functions `decideInstallMethod` / `decideReboot`.

  - **`install/diffHapAssets.ts`**: `diffHapAssets()` diffs two HAP (zip) file manifests via `node-stream-zip`; pure `diffEntryNames()` is exported and tested.

- 16114d8: Add build orchestration, HAP/module/ability discovery, and device-info helpers.

  - **`build/runHvigorw.ts`**: **builds are now parallel by default** — the forced `--no-parallel` is dropped. Pass `parallel: false` (or CLI `--no-parallel`) to restore serial builds for projects that need it. Also adds `abortSignal` (kills the hvigorw process and rejects `CancelledError`) and a pure, exported `buildHvigorwArgs()`.
  - **`build/buildHap.ts`**: `buildHap()` orchestrator — `ensureOhModules` → `runHvigorw` → `discoverHaps`, returning `{ exitCode, durationMs, discoveredHaps, warnings }`. `runHvigorw` stays a raw single-spawn primitive.
  - **`build/discoverHaps.ts`**: `discoverHaps()` groups built `*-signed`/`*-unsigned` HAPs by module folder (ported from the MCP `findHaps`).
  - **`build/ohpm.ts`**: `runOhpm()` and `ensureOhModules()` (installs only when `oh_modules/` is missing).
  - **`build/codelinter.ts`**: `runCodelinter()` + a pure, exported `parseCodelinterFindings()`.
  - **`project/listModules.ts`** / **`project/abilities.ts`**: read `modules[]` from build-profile.json5 and `abilities[]` from module.json5.
  - **`device/hidumper.ts`** / **`device/info.ts`**: `dumpScreen`/`dumpWindow`/`dumpRenderService` and `getDeviceInfo()` (collated `param get` + display resolution).

- 03f0a89: SDK/path catalog fixes and two new config keys.

  - **`getHvigorwPath` probe-and-fallback**: the project-local `hvigorw` is now used only when its `hvigor/` install is structurally complete (`hvigor/hvigor-wrapper.js` + `hvigor/node_modules`). HMOS-vendored projects (systemui, launcher) ship a local wrapper whose `hvigor/` install is absent and crashes on startup — those now transparently fall back to the cmd-tools `hvigorw`.
  - **`getOhpmPath(config)`** added; **`getCmdToolsBin(config, name = 'ohpm')`** generalized to resolve any cmd-tools binary (`hvigorw`, `codelinter`, …). Non-breaking: the 1-arg form still returns the ohpm path.
  - **`ALL_SDKS`** gains API 19 (5.1.1) and a per-OS `tarballStrip` table on `SdkRelease`; `getSdkFilename` now reads strip counts from that table (single source of truth) instead of a hard-coded version list. Behavior is unchanged for all known versions; unrecognized versions keep the historical 1/3 default.
  - **New config keys**: `sdkUrlBase` (defaults to the Huawei mirror `OHOS_URL_BASE`; lets a private/CI mirror be used for SDK downloads) and `applicationCertPath` (optional override for the bundled application cert chain during signing). The CLI exposes these as `ONIRO_SDK_URL_BASE` / `ONIRO_APPLICATION_CERT_PATH`.
  - **`isEmulatorInstalled`** now detects `images/run.sh` **or** `images/run.bat`, so a Windows-only emulator build is recognized.

- a54a857: Add a shared command-execution layer and standardize logging/error primitives (foundation for the device-lifecycle, observability, and install surface).

  - New `hdc/exec.ts`: `hdcExec`, `shell`, `runProcess`, and `ensureOk`. Commands are spawned with `shell: false` and args passed as an array, so command construction is injection-safe by construction. Resolves `{ code, stdout, stderr }` for any exit code; `ensureOk` opts into throw-on-non-zero. Supports per-call `timeoutMs`, `abortSignal` (rejects `CancelledError`), and an `onOutput` streaming hook.
  - New `scopedLogger(logger, scope)` in `ports` — standardizes the ad-hoc `[hdc]`/`[emulator]`/… prefixes.
  - New `CommandFailedError` in `ports` — distinguishes "ran and exited non-zero" from "could not spawn".
  - Internal: `hdc/app.ts` and `emulator/lifecycle.ts` now use the shared layer; their duplicated `execPromise` helpers are removed. **Fixes a shell-injection risk in `launchApp`**, which previously interpolated the ability/bundle names into a shell string. No public API signatures changed.

- e117386: Add hdc device primitives and extend the app helpers.

  - **`hdc/devices.ts`**: `listDevices()` (+ a pure, reusable `parseDeviceList()`) and `selectDevice(serial?)` — resolves an explicit serial, then `ONIRO_DEVICE_SERIAL`/`DEVICE_SERIAL`, then the single connected device.
  - **`hdc/param.ts`**: `paramGet(config, key)` and `paramSet(config, key, value)` (the canonical reboot path is `param set ohos.startup.powerctrl reboot`).
  - **`hdc/files.ts`**: `sendFile()` / `recvFile()` wrapping `hdc file send/recv`.
  - **`hdc/app.ts`**: `installApp` now returns a structured `InstallAppResult` (`{ installed, bundleName, hapPath, output }`); `launchApp` accepts an explicit `abilityName`; new `findRunningProcess()` (non-throwing `pidof` companion to `listRunningProcesses`), `uninstallApp()`, and `forceStop()`.
  - **`hdc/project.ts`**: `getMainAbility()` now falls back to `module.abilities[]` (first `visible`, then first) when `mainElement` is absent, and accepts an explicit `abilityName` to target a specific ability in a multi-ability module.

  `installApp`'s return type changed from `void` to `InstallAppResult`; this is source-compatible for callers that `await` and ignore the result.

- eb63f30: Add device-lifecycle and log-observability helpers.

  - **`hdc/wait.ts`**: `waitForCondition({ probe, timeoutMs, pollMs?, abortSignal?, onHeartbeat? })` — a generic deadline+poll+heartbeat loop (extracted from the emulator hdc-wait pattern). A throwing probe is treated as "not yet", which is what lets device waits tolerate the transient hdc disconnect during a reboot.
  - **`hdc/lifecycle.ts`**: `reboot()` (system via `param set ohos.startup.powerctrl reboot`; bootloader/recovery via `reboot <mode>`; tolerates the connection drop, and when `waitForBundle` is set waits for the device to go down and come back so it can't match the pre-reboot pid), `waitForBoot({ untilPidOf? })`, and `waitForBundle()` — all require a clean numeric pid before returning.
  - **`hdc/hilog.ts`**: `waitForLog()` (first matching entry; auto-respawns the stream so it survives a reboot), `watchLog()` (collect matches for a duration, deduped by default), `dumpLog()` (one-shot `hilog -x` with domain/bundle-pid/grep/tail filters, mirroring the proven MCP pipeline), and a pure exported `dedupEntries()`. `streamHilog` gains `domain` and `deviceSerial` options.

- b89b46f: Add rich-capture primitives: screenshots, input injection, and layout dump.

  - **`hdc/display.ts`**: `getDisplaySize()` — device render resolution from `hidumper -s 10 -a screen` (the W/H source; no image decoding).
  - **`hdc/screen.ts`**: `takeScreenshot()` returns raw JPEG `{ pixels, width, height }` via `snapshot_display` + `file recv`; `captureBurst()` returns raw frame buffers from a single device-side capture loop. The grid overlay / downscale / base64 stay in the MCP — **core adds no image dependency**.
  - **`hdc/input.ts`**: `sendInput()` (pixel-space `uitest uiInput`; the %→px step stays in the MCP), `sendGesture()` (chained `uitest uiInput drag` segments, routing to the raw-touch path when holds are requested), and `sendRawTouch()` (`uinput -T` — the press-time escape hatch; doc-comment warns the `-g` form silently no-ops under 500ms press/total windows). Command construction is factored into pure, tested builders (`buildInputCommand` / `buildGestureCommands` / `buildRawTouchCommand`).
  - **`hdc/dump.ts`**: `dumpLayout()` runs `uitest dumpLayout`, pulls the JSON, and returns a pruned tree with bounds/center normalized to 0–1; the `pruneLayout` + `parseBounds` logic is ported verbatim from the proven MCP and exported as pure functions.

- 637fff5: Add signing bootstrap and signing option overrides.

  - **`project/prepareSigning.ts`**: `prepareSigning()` is a no-op when `signatures/` + signingConfigs already exist (**present**), otherwise generates them via `generateSigningConfigs` (**fresh**). Avoids re-running the full generate flow when signing material is already in place.
  - **`generateSigningConfigs`**: new optional `passwords` (`{ store, key }`, default `'123456'` — the SDK keystore's password; override only with a matching custom keystore) and `applicationCertPath` (override the bundled `OpenHarmonyApplication.cer` for application-release signing). Defaults preserve current behavior exactly.

### Patch Changes

- e4c328a: Fix SDK and command-line-tools install failing with `EXDEV: cross-device link not permitted` when the OS temp directory and the install target are on different filesystems.

  Both installers extract under `os.tmpdir()` and then moved the result into place with `fs.renameSync`, which cannot cross a mount boundary. This broke `sdk install` / `cmdtools install` whenever `/tmp` is a `tmpfs` (common on systemd hosts) or the install path is a Docker volume / bind mount. A new internal `movePath` helper now falls back to a recursive copy-then-remove on `EXDEV`, preserving file modes and symlinks.

- e4c328a: `launchApp` now surfaces `aa start` launch failures instead of reporting success.

  `hdc shell aa start` exits 0 even when the launch is refused (a locked screen — `Error Code:10106102`, a missing ability, a permission denial), reporting the failure only in its output. `launchApp` checked the exit code but not the output, so callers were told the app launched when it had not. It now scans the output (via a new exported `detectAaStartFailure` helper) and throws an `OniroError` carrying the device's error text.

- ac9fa01: `reboot`/`waitForBundle`/`waitForBoot` now reconnect a TCP target across a reboot.

  hdc auto-reconnects a USB device when it re-enumerates, but a TCP target (e.g. an emulator at `127.0.0.1:55555`) must be reconnected explicitly with `hdc tconn` after the session drops — and a reboot drops it. Previously the post-reboot wait kept polling `pidof` over the dead socket and timed out even though the device had come back. The wait now re-issues `hdc tconn <serial>` (best-effort) before each poll when `deviceSerial` is a `host:port` address; USB serials and the no-serial case are unaffected.

## 0.6.2

### Patch Changes

- Fix signing of apps that request privileged (system_basic/system_core) permissions.

  - Route system*basic/system_core through the OpenHarmony **Application Release** key/cert chain (BMS rejects HAPs signed with the SDK's \_Profile* Release cert once an apl-elevated permission is requested).
  - New `--acls <list>` flag on `oniro-app sign` to populate the profile's `acls.allowed-acls`; omitting it leaves the existing template value untouched (`apl=normal` default unchanged).
  - `updateBuildProfile()` now preserves per-product `signingConfig` names from `build-profile.json5` instead of forcing `"default"`, so system-app source trees (e.g. `systemui` using `signingConfig: "release"`) work without manual renaming.

## 0.6.1

### Patch Changes

- a7a4437: Add a package README so each npm landing page shows install and usage info instead of "no readme data". No code changes.

## 0.6.0

### Minor Changes

- 9ed025e: First npm release of the rewritten cross-platform Node monorepo.

  - Replaces the `.deb`-only bash CLI with `@oniroproject/core` (library) and `@oniroproject/oniro-app` (CLI), runnable on Linux, macOS, and Windows.
  - Adds emulator launcher + reusable CI workflow, hilog streaming with buffer-level + line parser, and `--apl/--app-feature` flags for signing system-permission apps.
