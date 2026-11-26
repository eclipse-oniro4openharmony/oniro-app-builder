---
'@oniroproject/core': minor
'@oniroproject/oniro-app': minor
---

New `oniro-app emulator harmonyos` commands manage Huawei's HarmonyOS emulator (`Emulator`),
which the HarmonyOS command-line tools ship in `emulator/` from 26.0.0 on Linux. They list,
download and use its images, and create, start, stop and delete devices. Verified with Emulator
26.0.0.400 (command-line tools 26.0.0.821): a device on the HarmonyOS 7.0.0(26.0.0) image was
created, started headless on hdc port 15555 (ready in 92 s), ran an app (`app apply`,
`app launch --smoke`), was stopped and deleted. An existing device restarted with a window in
34 s.

- `license` lists the two agreements the emulator needs (the HarmonyOS SDK License Agreement to
  download images, the Software License and Service Agreement to start devices), says whether
  each is accepted and where to read it, and exits 1 while one is not. It accepts them only on
  request: `--accept`, or `--review` for Huawei's own prompt. `install` and `start` refuse until
  the agreement they need is accepted. Without it the emulator only prompts, and an image
  download then exits 0 having done nothing.
- `images` shows Huawei's catalogue. `install <image>` downloads one, taking the API level
  (`26`), the release (`7.0.0`) or the full name, and reports progress.
- `create <name> --image <image>` creates a device on a downloaded image. `list` shows the
  devices with their state and hdc address, and `delete` removes a stopped one.
- `start <name>` launches a device detached, with `--headless`, `--boot-mode`, `--hdc-port`,
  `--log` and `--wait-ready <seconds>`. It sets `__GL_SYNC_TO_VBLANK=0` unless that is set,
  because NVIDIA vsync doubled the emulator's frame-time p90. `stop` waits until the device has
  shut down, since the emulator reports success before then.
- The emulator is found at the new `ONIRO_HARMONYOS_EMULATOR_PATH`, else in the command-line
  tools at `ONIRO_CMD_TOOLS_PATH`, else next to the HarmonyOS SDK.
- `doctor` has a new `hos-emulator` check. When an emulator is found, it warns if `/dev/kvm` or
  a GPU render node is not accessible, or if the agreements are not accepted.
- Core: `findHarmonyOsEmulator`, `listHarmonyOsEmulatorDevices`, `listHarmonyOsEmulatorImages`,
  `resolveHarmonyOsEmulatorImage`, `installHarmonyOsEmulatorImage`,
  `createHarmonyOsEmulatorDevice`, `deleteHarmonyOsEmulatorDevice`, `startHarmonyOsEmulator`,
  `stopHarmonyOsEmulator`, the licence helpers, `checkHarmonyOsEmulatorHost`, and
  `checkHarmonyOsEmulator` for `doctor`. The new config key is `harmonyosEmulatorPath`.
  `runProcess` takes `input`, written to the child's stdin, which is then closed.
