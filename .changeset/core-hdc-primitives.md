---
"@oniroproject/core": minor
---

Add hdc device primitives and extend the app helpers.

- **`hdc/devices.ts`**: `listDevices()` (+ a pure, reusable `parseDeviceList()`) and `selectDevice(serial?)` — resolves an explicit serial, then `ONIRO_DEVICE_SERIAL`/`DEVICE_SERIAL`, then the single connected device.
- **`hdc/param.ts`**: `paramGet(config, key)` and `paramSet(config, key, value)` (the canonical reboot path is `param set ohos.startup.powerctrl reboot`).
- **`hdc/files.ts`**: `sendFile()` / `recvFile()` wrapping `hdc file send/recv`.
- **`hdc/app.ts`**: `installApp` now returns a structured `InstallAppResult` (`{ installed, bundleName, hapPath, output }`); `launchApp` accepts an explicit `abilityName`; new `findRunningProcess()` (non-throwing `pidof` companion to `listRunningProcesses`), `uninstallApp()`, and `forceStop()`.
- **`hdc/project.ts`**: `getMainAbility()` now falls back to `module.abilities[]` (first `visible`, then first) when `mainElement` is absent, and accepts an explicit `abilityName` to target a specific ability in a multi-ability module.

`installApp`'s return type changed from `void` to `InstallAppResult`; this is source-compatible for callers that `await` and ignore the result.
