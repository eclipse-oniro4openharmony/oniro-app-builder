---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- New `doctor [project-dir]`: one verdict on whether this machine can build, check, sign, install and test, with a
  fix for each problem. It checks node and java, the SDK the project compiles with (`--fix` installs it), that the
  command-line tools are a complete install (#16) and of the project's flavour, a `check arkts` self-test, hdc and a
  reachable device at the project's API, the signing material, and free disk space. `--json` adds the versions in
  use (tools, SDK, java, hdc, device API), so a change between two runs shows (#25). Exits 1 when a check fails.
- Core exports `runDoctor` and its checks, and `resolveProjectSdkDir`.
