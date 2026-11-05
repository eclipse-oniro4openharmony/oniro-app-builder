---
'@oniroproject/oniro-app': patch
'@oniroproject/core': patch
---

Fixes:

- `build` no longer silently ships an OpenHarmony-signed HAP for a HarmonyOS product (#19). When the product's
  `runtimeOS` is HarmonyOS and its signingConfig lacks `type: "HarmonyOS"` (the material a plain `sign` writes), the
  build still passes but warns on stderr, and `build --json` adds a `signing` warning diagnostic naming
  `oniro-app sign --harmonyos`. The mirror case, HarmonyOS material on an OpenHarmony product, warns too.
- Core exports `signingMismatch`; `DiagnosticSource` gains `signing`.
