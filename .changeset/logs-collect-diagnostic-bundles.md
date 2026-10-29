---
'@oniroproject/oniro-app': minor
'@oniroproject/core': patch
---

Add `logs collect`, which packages a device's logs and diagnostic snapshots into one bundle.

New:

- `logs collect [--device s] [--package b] [--pid p] [--tag t] [--level l] [--duration s] [--redact] [-o dir]
  [--json]` captures the hilog buffer (`hilog -x`), faultlog entries (`hidumper -e`, scoped to `--package`), the
  device name, the process list, and memory and thread snapshots into a timestamped `incident-…` directory, with a
  `manifest.json` recording each command's result, and zips it. `--duration` (default 600 s) keeps the hilog
  records from that window, measured against the device clock. `--pid`, `--tag` and `--level` add a filtered hilog
  view. With `--redact`, the ZIP is built only from a redacted copy, and redaction fails closed on binary or
  non-UTF-8 files. A partial bundle exits 1. `logs -o <file>` still captures a whole session.

Fixes:

- `parseDeviceList` reports a UART endpoint that hdc lists as `Ready` with that status instead of `Unknown`, so
  `selectDevice` no longer counts it as a connected device (`Multiple devices connected (COM3, …)`).
- `runProcess` decodes stdout and stderr as streams, so a multi-byte UTF-8 character split across two chunks is no
  longer turned into replacement characters.
