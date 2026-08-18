---
"@oniroproject/oniro-app": minor
"@oniroproject/core": minor
---

Keep install temporaries off `/tmp`, and explain it when they run out of room.

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
