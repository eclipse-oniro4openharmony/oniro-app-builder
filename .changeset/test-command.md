---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- `oniro-app test` builds a module's main and `ohosTest` HAPs, installs both, runs the suite with `aa test` and
  prints one line per case, with the message and the test-file location of a failure. It exits 0 when every case
  passed, 1 when one failed or threw, and 2 when the run did not complete (build failed, HAP missing, test module not
  found, no case ran, timeout, no device). `--json` prints the cases (with the runner's raw status code), the summary,
  the runner's result code, the app's hilog lines during the run, and a failed build's diagnostics. `--class`,
  `--timeout`, `--run-timeout`, `--no-build`, `--module`, `--product` and `--device` select what runs where.
- Before the run the screen is turned on, a lock screen without a credential is swiped away, and the screen is kept on
  until the run ends (`--no-wake` leaves it alone).
- Core exports `runTests`, `parseTestOutput`, `aaTestCommand`, `testHapPath`, `readTestModuleName`,
  `decideOutcome`, `isTestHap`, `wakeAndUnlock`, `holdScreenOn`, `parsePowerState` and `isLockScreenShown`.

Fixes:

- `discoverHaps` grouped a module's test HAP (`entry-ohosTest-signed.hap`) with its own HAPs and, the test HAP being
  newer, `app apply` and `pickHap` chose it over the app. Test HAPs are now left out.
