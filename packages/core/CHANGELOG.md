# @oniroproject/core

## 0.6.1

### Patch Changes

- a7a4437: Add a package README so each npm landing page shows install and usage info instead of "no readme data". No code changes.

## 0.6.0

### Minor Changes

- 9ed025e: First npm release of the rewritten cross-platform Node monorepo.

  - Replaces the `.deb`-only bash CLI with `@oniroproject/core` (library) and `@oniroproject/oniro-app` (CLI), runnable on Linux, macOS, and Windows.
  - Adds emulator launcher + reusable CI workflow, hilog streaming with buffer-level + line parser, and `--apl/--app-feature` flags for signing system-permission apps.
