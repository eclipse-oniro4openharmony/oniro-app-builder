---
'@oniroproject/oniro-app': patch
---

Fixes:

- `oniro-app --help` piped into another program (`oniro-app --help | less`) is no longer cut off at 8 KB on macOS.
  Help, `--version` and usage errors now exit once their output has been written, and so do errors.
