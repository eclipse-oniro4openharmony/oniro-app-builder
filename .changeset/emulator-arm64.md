---
'@oniroproject/core': minor
'@oniroproject/oniro-app': minor
---

The arm64 Oniro emulator:

- `emulator install` picks the emulator the host runs with a hypervisor: the
  arm64 one (`oniro_emulator_arm64.zip`) on Apple Silicon Macs (HVF) and arm64
  Linux (KVM), the x86_64 one (`oniro_emulator.zip`, as before) elsewhere. While
  a release has no arm64 emulator, arm64 hosts fall back to the x86_64 one.
  `--arch x86_64|arm64` asks for one explicitly; `ONIRO_EMULATOR_URL` still
  overrides both. The installed architecture is printed at the end.
- `emulator stop` and `emulator status` also find `qemu-system-aarch64`.
- Pool instances (`--instance`) stay x86_64-only and say so when the installed
  emulator is arm64.
