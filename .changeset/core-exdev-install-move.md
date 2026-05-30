---
"@oniroproject/core": patch
---

Fix SDK and command-line-tools install failing with `EXDEV: cross-device link not permitted` when the OS temp directory and the install target are on different filesystems.

Both installers extract under `os.tmpdir()` and then moved the result into place with `fs.renameSync`, which cannot cross a mount boundary. This broke `sdk install` / `cmdtools install` whenever `/tmp` is a `tmpfs` (common on systemd hosts) or the install path is a Docker volume / bind mount. A new internal `movePath` helper now falls back to a recursive copy-then-remove on `EXDEV`, preserving file modes and symlinks.
