---
"@oniroproject/oniro-app": minor
"@oniroproject/core": minor
---

Let installs put their temporary files somewhere other than `/tmp`, and explain it when they
run out of room.

`sdk install`, `cmdtools install`, and `emulator install` download a multi-GB archive and
extract it in a scratch directory under the system temp dir. On most Linux systems `/tmp` is a
RAM-backed `tmpfs` sized from available memory, so machines with plenty of disk but little free
RAM could not install the SDK or the command-line tools at all.

- **`--tmp-dir <path>` on all three install commands**, plus the `ONIRO_TMP_DIR` environment
  variable (`tmpDir` config key) for a global default. Precedence: flag → env → system temp dir.
  The directory is created when missing, and the per-run scratch folder inside it is removed
  afterwards.
- **Fail before downloading** when the advertised `content-length` does not fit in the free
  space of the scratch directory, so nothing is written when it cannot fit.
- **Clear errors instead of a crash.** A write failure during the download had no handler, so an
  out-of-space `/tmp` surfaced as an unhandled `ENOSPC` event that killed the process.
  Out-of-space failures anywhere in an install now raise `InsufficientSpaceError`, naming the
  directory, how much room was needed versus available, whether that directory is RAM-backed
  (`tmpfs`), and the `--tmp-dir` / `ONIRO_TMP_DIR` remedy.

New in `@oniroproject/core`: `InsufficientSpaceError` and the temp-space helpers in `sdk/tmp.ts`
(`resolveTmpRoot`, `createTempWorkDir`, `getFreeSpaceBytes`, `isRamBackedPath`, `ensureFreeSpace`,
`isOutOfSpaceError`, `toSpaceError`, `formatBytes`). `downloadFile` gains `what` and `tmpRoot`
options; the three install option objects gain `tmpDir`.
