---
"@oniroproject/core": minor
---

Add device-lifecycle and log-observability helpers.

- **`hdc/wait.ts`**: `waitForCondition({ probe, timeoutMs, pollMs?, abortSignal?, onHeartbeat? })` — a generic deadline+poll+heartbeat loop (extracted from the emulator hdc-wait pattern). A throwing probe is treated as "not yet", which is what lets device waits tolerate the transient hdc disconnect during a reboot.
- **`hdc/lifecycle.ts`**: `reboot()` (system via `param set ohos.startup.powerctrl reboot`; bootloader/recovery via `reboot <mode>`; tolerates the connection drop, and when `waitForBundle` is set waits for the device to go down and come back so it can't match the pre-reboot pid), `waitForBoot({ untilPidOf? })`, and `waitForBundle()` — all require a clean numeric pid before returning.
- **`hdc/hilog.ts`**: `waitForLog()` (first matching entry; auto-respawns the stream so it survives a reboot), `watchLog()` (collect matches for a duration, deduped by default), `dumpLog()` (one-shot `hilog -x` with domain/bundle-pid/grep/tail filters, mirroring the proven MCP pipeline), and a pure exported `dedupEntries()`. `streamHilog` gains `domain` and `deviceSerial` options.
