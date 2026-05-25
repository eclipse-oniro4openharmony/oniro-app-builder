---
'@oniroproject/core': minor
'@oniroproject/oniro-app': minor
---

First npm release of the rewritten cross-platform Node monorepo.

- Replaces the `.deb`-only bash CLI with `@oniroproject/core` (library) and `@oniroproject/oniro-app` (CLI), runnable on Linux, macOS, and Windows.
- Adds emulator launcher + reusable CI workflow, hilog streaming with buffer-level + line parser, and `--apl/--app-feature` flags for signing system-permission apps.
