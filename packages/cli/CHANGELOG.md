# @oniroproject/oniro-app

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
