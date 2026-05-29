---
"@oniroproject/core": minor
---

Add build orchestration, HAP/module/ability discovery, and device-info helpers.

- **`build/runHvigorw.ts`**: **builds are now parallel by default** — the forced `--no-parallel` is dropped. Pass `parallel: false` (or CLI `--no-parallel`) to restore serial builds for projects that need it. Also adds `abortSignal` (kills the hvigorw process and rejects `CancelledError`) and a pure, exported `buildHvigorwArgs()`.
- **`build/buildHap.ts`**: `buildHap()` orchestrator — `ensureOhModules` → `runHvigorw` → `discoverHaps`, returning `{ exitCode, durationMs, discoveredHaps, warnings }`. `runHvigorw` stays a raw single-spawn primitive.
- **`build/discoverHaps.ts`**: `discoverHaps()` groups built `*-signed`/`*-unsigned` HAPs by module folder (ported from the MCP `findHaps`).
- **`build/ohpm.ts`**: `runOhpm()` and `ensureOhModules()` (installs only when `oh_modules/` is missing).
- **`build/codelinter.ts`**: `runCodelinter()` + a pure, exported `parseCodelinterFindings()`.
- **`project/listModules.ts`** / **`project/abilities.ts`**: read `modules[]` from build-profile.json5 and `abilities[]` from module.json5.
- **`device/hidumper.ts`** / **`device/info.ts`**: `dumpScreen`/`dumpWindow`/`dumpRenderService` and `getDeviceInfo()` (collated `param get` + display resolution).
