---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- Emulator pool: `emulator start --instance <n>` (1..99) runs pool instance `n`, its own QEMU with `run.sh`'s
  command line on qcow2 copy-on-write overlays of the bundled images (`<emulator dir>/instances/<n>/`), so several
  emulators run side by side, each with its own `/data`, and the bundled images are only read. Ports are bound to
  127.0.0.1 at the instance's number: hdc `55555+n`, VNC display `n` (`5900+n`), telnet serial `4444+n`; a taken
  port fails the start, naming it. Headless by default (`--window` for SDL), `--memory` (default `2048M`), `--smp`
  (default 2), `--resolution`, `--fresh` (discard the overlays: a factory reset), `--boot-timeout`, `--qemu`,
  `--accel`, `--json`.
- `emulator start --wait-ready <s>` waits until the guest reports `bootevent.boot.completed=true`, for pool
  instances and the default emulator alike. It connects with `hdc tconn` only and never restarts the hdc server.
- `emulator status` lists every instance (the default emulator as 0) with a health code: `stopped`, `booting`,
  `ready`, `hdc-lost` (was ready, hdc can no longer reach it), `stuck` (not ready `--boot-timeout` seconds after
  launch). `--json` adds an `instances` array to the existing fields; `--instance <n>` reports one instance.
- `emulator stop --instance <n>` stops only that instance's QEMU (by its recorded PID) and drops it from hdc;
  `--discard` also deletes its overlays. `emulator stop` without `--instance` behaves as before.
- The default emulator (`run.sh`) and pool instances share the base images, which `run.sh` opens read-write, so
  each refuses to start while the other runs. `emulator status`'s `running` no longer counts pool instances.
- Core exports `startPoolInstance`, `stopPoolInstance`, `getPoolInstanceStatus`, `listPoolInstanceStatuses`,
  `waitPoolInstanceReady`, `probeEmulatorBoot`, `classifyEmulatorHealth`, `poolInstancePorts`, `buildPoolQemuArgs`,
  `emulatorAccelArgs` and the `EmulatorHealth`, `EmulatorInstanceStatus` and `PoolInstanceState` types;
  `EmulatorStatus` gains `instances`, and `StartEmulatorOptions` gains `waitReadySeconds`.
