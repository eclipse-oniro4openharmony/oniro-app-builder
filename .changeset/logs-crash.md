---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- New `logs crash`: fetches an app's newest faultlog from the device and says what happened. It classifies the log as
  `cpp_crash`, `js_crash`, `app_freeze`, `sample_stack` or `unknown` with a confidence, and reports the reason, the top
  frame, the first frame in the project's own code with `file`, `line` and `column` (for a native crash, the ArkTS
  code that called into it), the JS error name, message and stack, the native frames (library, symbol, build id) and,
  for a freeze, the binder chain and any deadlock. `--bundle` defaults to the project in the current directory,
  `--since` takes seconds or an ISO time, `--wait` polls until hiview has written the log, `--path` analyses a local
  file, and `--json` prints the verdict. The fetched log is saved under `--output` (`~/.oniro/faultlogs`).
- `logs crash` also reads faultloggerd's crash records in `/data/log/faultlog/temp`. Some builds never turn an app's
  native crash into a faultlog (hiview rejects processdump at `/root/system/bin/processdump`), so the record is the
  only trace of it.
- Core exports `latestCrash` (the newest fault of a bundle since a time, or null), `analyzeFaultLog`,
  `classifyFaultLog`, `listFaultLogs`, `readFaultLog`, the per-kind parsers and the frame and binder-chain helpers.
  The classifier and parsers are adapted from deveco-cli's `faultlog/` module (MIT); they also read the frame form
  devices print, `at f entry (file:line:col)`, which upstream's patterns miss.
