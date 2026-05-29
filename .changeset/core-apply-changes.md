---
"@oniroproject/core": minor
---

Add install orchestration that verifies the running process took the change.

- **`install/apply.ts`**: `applyChanges()` installs a HAP and handles the three failure modes a naive "install the most recent signed HAP" deploy ignores:
  1. **sign-info-inconsistent (9568332)** on `hdc install -r` — for a normal app, uninstall + fresh install; for a **system bundle, refuse** (uninstalling it can brick the device) unless `allowUninstall` is set;
  2. **asset-cache invalidation** — when the new HAP's file manifest changed vs the installed one, reboot (the ACE extractor cache is path-keyed and survives a process kill);
  3. **persistent-bundle restart** — when a system bundle's pid didn't change after install, reboot.

  Multi-module projects resolve the right HAP via `discoverHaps` (errors on ambiguity instead of installing the wrong module). The branch logic is exported as pure, tested functions `decideInstallMethod` / `decideReboot`.
- **`install/diffHapAssets.ts`**: `diffHapAssets()` diffs two HAP (zip) file manifests via `node-stream-zip`; pure `diffEntryNames()` is exported and tested.
