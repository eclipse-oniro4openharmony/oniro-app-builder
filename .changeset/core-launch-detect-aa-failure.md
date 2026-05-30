---
"@oniroproject/core": patch
---

`launchApp` now surfaces `aa start` launch failures instead of reporting success.

`hdc shell aa start` exits 0 even when the launch is refused (a locked screen — `Error Code:10106102`, a missing ability, a permission denial), reporting the failure only in its output. `launchApp` checked the exit code but not the output, so callers were told the app launched when it had not. It now scans the output (via a new exported `detectAaStartFailure` helper) and throws an `OniroError` carrying the device's error text.
