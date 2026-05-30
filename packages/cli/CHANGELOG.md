# @oniroproject/oniro-app

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
