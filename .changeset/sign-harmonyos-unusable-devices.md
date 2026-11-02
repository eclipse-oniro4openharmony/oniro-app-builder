---
'@oniroproject/oniro-app': patch
'@oniroproject/core': patch
---

Fixes:

- `sign --harmonyos` no longer says `No device is connected` when a device is connected but could not be registered.
  Each attached device it cannot use gets a warning that says why (unauthorized, offline, no UDID reported, or no
  answer), and the summary then reads `No connected device could be registered`. The error for a team with no
  registered device no longer claims that nothing is connected, and says what to do.
- `sign --harmonyos` reads a device whose status hdc does not report, as the other device commands do, instead of
  skipping it silently. Core exports `isUsableDevice`.
- The `--harmonyos` help and the README say that a connected device is registered only if it reports a UDID.
