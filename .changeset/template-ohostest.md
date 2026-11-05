---
'@oniroproject/oniro-app': patch
---

Fixes:

- The `ohosTest` module of every template declared `deviceTypes: ["phone"]`, which the OpenHarmony SDK has no
  system-capability set for, so the test HAP of a scaffolded app failed at `SyscapTransform` with `00303060
  Configuration Error`. It now mirrors the main module (`default`).
- The templates' tests exercise the template's own code: `EmptyAbility` and `HarmonyOSApp` start `EntryAbility` and
  drive `pages/Index` with UiTest (tap the greeting, expect `Welcome`), and `NativeCpp` calls the native `add` through
  `libentry.so`.
