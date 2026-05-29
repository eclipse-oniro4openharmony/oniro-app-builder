---
"@oniroproject/oniro-app": minor
---

Expose the new core device/build/install/signing surface as CLI subcommands.

New commands: `reboot`, `wait` (`--log`/`--boot`/`--bundle`), `watch --log`, `screenshot [--burst]`, `dump [layout]`, `devices`, `file send`/`file recv`, `lint`, `input`, and `gesture`. The `app` command gains `apply` (verified install with sign-info/asset-cache/restart handling), `uninstall`, and `stop`, and `app launch` gains `--ability`. `sign` gains `--bootstrap` (no-op when signing material is present, else generate) plus `--store-password`/`--key-password`.

`build` now runs the `buildHap` orchestrator (auto `ohpm install --all` when `oh_modules/` is missing, then build, then HAP discovery) and **builds in parallel by default** — pass `--no-parallel` to restore serial builds, `--no-deps` to skip the ohpm step, and `--json` to emit the discovered HAPs.

Read/observe commands (`devices`, `dump`, `wait --log`, `watch`, `lint`, `app apply`) support `--json` on stdout; logs/progress stay on stderr. Requires `@oniroproject/core@^0.7.0`.
