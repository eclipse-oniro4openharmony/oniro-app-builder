---
"@oniroproject/oniro-app": patch
---

Two `app apply` / device-process fixes, both surfaced while deploying an app whose code
runs in an **extension-ability** process:

- **`app apply`: make `--bundle` optional.** When omitted it now auto-resolves the bundle
  name from the project's `AppScope/app.json5`, matching how `app launch` and `build`
  already discover the bundle/ability. Previously `--bundle` was required, inconsistent with
  the rest of the device commands.

- **Detect extension-ability processes when checking "is the bundle running".**
  `findRunningProcess` matched only the bundle's main (UIAbility) process via
  `pidof '<bundle>'`. Apps whose only live process is an extension ability — ServiceExtension,
  FormExtension, UIExtension, input method, etc. — run under a separate process name
  `"<bundle>:<ext>"` and were reported as not running (so `app apply` printed `pid - -> -`
  and the wait/log helpers couldn't find them). It now falls back to `track-jpid` and matches
  `"<bundle>"`, `"<bundle>/…"`, or `"<bundle>:…"`. This makes the apply pre/post-pid check,
  `wait --bundle`, and hilog pid filtering work for extension-hosted apps.
