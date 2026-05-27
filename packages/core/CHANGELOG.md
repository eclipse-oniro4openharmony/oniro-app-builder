# @oniroproject/core

## 0.6.2

### Patch Changes

- Fix signing of apps that request privileged (system_basic/system_core) permissions.

  - Route system_basic/system_core through the OpenHarmony **Application Release** key/cert chain (BMS rejects HAPs signed with the SDK's _Profile_ Release cert once an apl-elevated permission is requested).
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
