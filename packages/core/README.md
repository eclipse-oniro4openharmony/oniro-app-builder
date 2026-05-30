# @oniroproject/core

The library that powers the Oniro/OpenHarmony app-development toolchain. It wraps SDK installation, command-line-tools setup, project scaffolding, signing-config generation, `hvigorw` builds, emulator lifecycle, and the full `hdc` device surface (install/launch, files, input, screenshot, UI-layout dump, hilog, reboot/wait) — behind a **vscode-agnostic, non-interactive API** that runs on Linux, macOS, and Windows.

This package backs [`@oniroproject/oniro-app`](https://www.npmjs.com/package/@oniroproject/oniro-app) (the `oniro-app` CLI) and the same functionality embedded in editor extensions and MCP servers. If you just want to build and run Oniro apps from a shell, install the CLI; install this library to embed the functionality in your own tool.

## Install

```bash
npm install @oniroproject/core
```

Requires **Node.js 20+**. The package is ESM-first and ships CommonJS + `.d.ts` (`import` and `require` both resolve). External tools are still required at runtime for the operations that shell out to them: `java`/`keytool` for signing, and the OpenHarmony command-line tools (`hvigorw`, `ohpm`, `hdc`, `codelinter`) for building and device operations — both of which the library can also install for you.

## Design

Core has no dependency on VS Code, a TTY, or `console`. Frontends inject the environment through a few small **ports**, and every function returns data (or throws a typed error) rather than printing or calling `process.exit`.

- **`ConfigProvider`** supplies paths and URLs (SDK root, tools path, mirror URLs). The CLI reads these from `ONIRO_*` env vars; tests use `staticConfig({...})`.
- **`Logger`** / **`ProgressReporter`** are optional injectables — default to no-ops, so nothing is written unless you wire them up (`consoleLogger` is provided for quick use).
- Most functions take a **single options object** whose first field is `config`, plus an optional `logger`. Device operations add `deviceSerial?`, `timeoutMs?`, and `abortSignal?`.
- Results are **JSON-safe values**; screenshots return **raw JPEG bytes** (no image decoding, no heavy dependencies).
- Long-running operations accept an **`AbortSignal`** and reject with `CancelledError` when aborted.

## Quick start

Build and deploy an app:

```ts
import {
  staticConfig,
  consoleLogger,
  buildHap,
  installApp,
  launchApp,
} from '@oniroproject/core';

// A ConfigProvider tells core where the SDK / tools / emulator live.
// staticConfig is the simplest one; the CLI reads these from ONIRO_* env vars.
const config = staticConfig({
  sdkRootDir: '${userHome}/setup-ohos-sdk',
  cmdToolsPath: '${userHome}/command-line-tools',
});

const build = await buildHap({ config, projectDir: '/path/to/app', logger: consoleLogger });
console.log(build.discoveredHaps); // { entry: { signed: [...], unsigned: [...] } }

await installApp({ config, projectDir: '/path/to/app', logger: consoleLogger });
await launchApp({ config, projectDir: '/path/to/app', logger: consoleLogger });
```

Drive a connected device:

```ts
import { staticConfig, takeScreenshot, dumpLayout, sendInput, waitForLog } from '@oniroproject/core';
import { writeFile } from 'node:fs/promises';

const config = staticConfig();

const shot = await takeScreenshot({ config });      // { pixels: Buffer, width, height }
await writeFile('shot.jpeg', shot.pixels);

const { tree } = await dumpLayout({ config });      // pruned, 0–1-normalized UI tree
await sendInput({ config, type: 'click', pxX: 200, pxY: 400 });

const entry = await waitForLog({ config, pattern: /ability launched/i, timeoutMs: 10_000 });
console.log(entry.tag, entry.message);
```

## API reference

`import { … } from '@oniroproject/core'` — everything below is a named export. `VERSION` is the package version string.

### Runtime seams (ports)

The injection points every frontend implements, plus their defaults.

| Export | Description |
| --- | --- |
| `interface ConfigProvider` / `type ConfigKey` | `get(key, fallback)`. Keys: `sdkRootDir`, `cmdToolsPath`, `emulatorDir`, `hapPath`, `cmdToolsUrlLinux/Windows/Mac`, `emulatorUrl`, `sdkUrlBase`, `applicationCertPath`. |
| `staticConfig(values?)` | An in-memory `ConfigProvider` (expands `${userHome}`). For tests and as a base for frontend impls. |
| `defaultPaths` | The fallback values core uses when a key is unset. |
| `interface Logger` / `noopLogger` / `consoleLogger` | 4-level logger (`debug`/`info`/`warn`/`error`). Defaults to no-op. |
| `scopedLogger(logger, scope)` | Wrap a logger so every message is prefixed `[<scope>] `. |
| `interface ProgressReporter` / `ProgressUpdate` / `noopProgress` | `report({ message?, increment? })` for download/extract progress. |
| `interface Prompter` / `nonInteractivePrompter` | Interactive-prompt port; the non-interactive one throws on any prompt. |
| `interface OniroContext` / `defaultContext(overrides?)` | Bundles `{ logger, config }` for callers that prefer a context object. |

**Errors** — all extend `OniroError` (which carries an optional `cause`):

`OniroError` · `SdkNotInstalledError` · `CmdToolsNotInstalledError` · `UnsupportedPlatformError` · `ChecksumMismatchError` · `CancelledError` · `CommandFailedError` (carries `command`, `exitCode`, `stderr`).

### SDK management

| Export | Signature | Description |
| --- | --- | --- |
| `downloadAndInstallSdk` | `(InstallSdkOptions) => Promise<void>` | Download + install an SDK release into `<sdkRootDir>/<os>/<api>`, reporting progress. |
| `getSupportedSdksForUi` | `(config) => SdkInfo[]` | Known SDKs annotated with `installed`, newest first. |
| `getInstalledSdks` | `(config) => string[]` | Versions with at least one OS-folder install. |
| `removeSdk` | `(config, api) => boolean` | Remove an installed SDK by API level across OS folders. |
| `detectProjectSdkVersion` | `(projectRoot, logger?) => number \| undefined` | Read `compileSdkVersion` from a project's `build-profile.json5`. |
| `ALL_SDKS` / `SdkRelease` | — | Catalog of known releases (`version`, `api`, `tarballStrip`). |
| `OHOS_URL_BASE` | — | Default SDK mirror base URL. |
| `getOsFolder()` / `getSdkFilename(version?)` | — | Map the host platform to its OS folder / SDK archive (`SdkArchiveInfo`). |

**Path resolvers** (all take `config`): `getSdkRootDir`, `getOhosBaseSdkHome`, `getCmdToolsPath`, `getEmulatorDir`, `getHdcPath`, `getOhpmPath`, `getCmdToolsBin(config, name?)`, `getHvigorwPath(config, projectDir)` (prefers the project-local wrapper only when it is structurally complete, else the bundled one).

**Download/archive primitives**: `downloadFile(DownloadOptions)`, `verifySha256(file, sha256File)`, `extractZipWithProgress(ExtractZipOptions)` (Zip-Slip-safe), `extractTarball(tar, dest, strip?)`.

### Command-line tools

| Export | Signature | Description |
| --- | --- | --- |
| `installCmdTools` | `(InstallCmdToolsOptions) => Promise<void>` | Install the tools by download or from a local zip (`localZipPath`). |
| `getCmdToolsStatus` | `(config) => CmdToolsStatus` | `{ installed, status }` (version when present). |
| `isCmdToolsInstalled` | `(config) => boolean` | — |
| `removeCmdTools` | `(config) => void` | Delete the install. |
| `getCmdToolsDownloadUrl` | `(config, platform?) => string` | Per-platform download URL (only Linux is public on the mirror). |
| `findCmdToolsSourceDir` | `(extractPath) => string` | Locate the tools root inside an extraction folder. |

### Signing

`java` must be on `PATH` (the OpenHarmony hap-sign-tool ships as a `.jar`).

| Export | Signature | Description |
| --- | --- | --- |
| `generateSigningConfigs` | `(GenerateSigningConfigsOptions) => void` | Generate keys/certs/material and write the `signingConfigs` block into `build-profile.json5`. |
| `pickSigningKind` | `(apl) => SigningKind` | `'profile-release'` for `normal`, `'application-release'` for `system_basic`/`system_core`. |
| `detectSigningConfigNames` | `(projectDir) => string[]` | The `products[*].signingConfig` names (falls back to `['default']`). |
| `createMaterial` / `getKey` / `encryptPwd` / `decryptPwd` | — | Signing-material key derivation + password encryption used in the profile. |
| `APL_VALUES` / `APP_FEATURE_VALUES` | — | Allowed values for `Apl` (`normal`/`system_basic`/`system_core`) and `AppFeature` (`hos_normal_app`/`hos_system_app`). |
| types | `GenerateSigningConfigsOptions`, `SigningPasswords`, `SigningKind`, `Apl`, `AppFeature` | `apl`, `appFeature`, `acls`, `passwords`, and `applicationCertPath` all default to the SDK's dev cert / `123456` keystore. |

### Emulator

| Export | Signature | Description |
| --- | --- | --- |
| `installEmulator` | `(InstallEmulatorOptions) => Promise<void>` | Download + extract the QEMU emulator into `emulatorDir`. |
| `isEmulatorInstalled` / `removeEmulator` | `(config) => boolean` / `void` | — |
| `startEmulator` | `(StartEmulatorOptions) => Promise<void>` | Launch detached via `run.sh`/`run.bat`; optional `headless`, `logFile`, `connect`, and `waitForHdcSeconds`. |
| `stopEmulator` | `(logger?) => Promise<void>` | Kill running emulator processes. |
| `attemptHdcConnection` | `(config, address?, logger?) => Promise<boolean>` | Try to connect `hdc` (default `127.0.0.1:55555`). |

### hdc — process execution

The injection-safe primitives every device operation builds on (`spawn` with `shell: false`; args are arrays, never interpolated into a shell string).

| Export | Signature | Description |
| --- | --- | --- |
| `runProcess` | `(RunProcessOptions) => Promise<HdcExecResult>` | Spawn any process and collect `{ code, stdout, stderr }`. Resolves for **any** exit code. |
| `hdcExec` | `(HdcExecOptions) => Promise<HdcExecResult>` | Run `hdc [-t <serial>] <args…>`. |
| `shell` | `(HdcShellOptions) => Promise<HdcExecResult>` | Convenience wrapper for `hdc shell <command>`. |
| `ensureOk` | `(result, command) => HdcExecResult` | Throw `CommandFailedError` when `code !== 0`; otherwise pass through. |
| `type OutputSink` | — | `(chunk, 'stdout'\|'stderr') => void`, for streaming output. |

### hdc — devices & system properties

| Export | Signature | Description |
| --- | --- | --- |
| `listDevices` | `(config, opts?) => Promise<DeviceInfo[]>` | Parse `hdc list targets -v`. |
| `selectDevice` | `(config, serial?, opts?) => Promise<string>` | Resolve the target: explicit serial → `ONIRO_DEVICE_SERIAL`/`DEVICE_SERIAL` env → the single connected device (throws on ambiguity). |
| `parseDeviceList` | `(stdout) => DeviceInfo[]` | Pure parser (unit-testable). |
| `paramGet` / `paramSet` | `(config, key[, value], opts?) => Promise<…>` | Read/write system properties via `param get`/`set`. |

### hdc — files

`sendFile(SendFileOptions)` / `recvFile(RecvFileOptions)` — push/pull a file via `hdc file send`/`recv`.

### hdc — lifecycle & waiting

| Export | Signature | Description |
| --- | --- | --- |
| `reboot` | `(RebootOptions) => Promise<void>` | `system` (via `param set ohos.startup.powerctrl reboot`), `bootloader`, or `recovery`. Optionally waits for a bundle to return (and reconnects a TCP target across the reboot). |
| `waitForBundle` | `(WaitForBundleOptions) => Promise<void>` | Poll `pidof <bundle>` until it has a clean numeric pid. |
| `waitForBoot` | `(WaitForBootOptions) => Promise<void>` | Poll until reachable (and optionally `untilPidOf` has a pid). Tolerant of the reboot disconnect. |
| `waitForCondition` | `(WaitForConditionOptions) => Promise<void>` | Generic deadline + poll + heartbeat loop. A throwing probe counts as "not yet". |

### hdc — app install, launch & process

| Export | Signature | Description |
| --- | --- | --- |
| `installApp` | `(InstallAppOptions) => Promise<InstallAppResult>` | Install the signed `.hap` (resolves the path from `hapPath` / config / default). |
| `launchApp` | `(LaunchAppOptions) => Promise<void>` | `aa start` the entry ability (or an explicit `abilityName`). |
| `uninstallApp` / `forceStop` | `(BundleOptions) => Promise<void>` | Uninstall / force-stop by bundle name. |
| `findRunningProcess` | `(BundleOptions) => Promise<RunningProcess \| null>` | Non-throwing `pidof` check. |
| `listRunningProcesses` / `findAppProcessId` | — | `track-jpid`-based process listing / project-PID resolution. |
| `detectAaStartFailure` | `(output) => string \| null` | Detect a refused launch (`aa start` exits 0 even on failure). |
| `getBundleName` / `getMainAbility` | `(projectDir[, module?, ability?]) => string` | Read the bundle / resolve the launch ability from project manifests. |

### hdc — capture, display & UI dump

| Export | Signature | Description |
| --- | --- | --- |
| `takeScreenshot` | `(ScreenshotOptions) => Promise<Screenshot>` | `{ pixels: Buffer, width, height }` — raw JPEG, no decode. |
| `captureBurst` | `(CaptureBurstOptions) => Promise<Buffer[]>` | N frames `intervalMs` apart, pulled back in order. |
| `getDisplaySize` | `(config, opts?) => Promise<DisplaySize \| null>` | Render resolution from `hidumper` (no image work). |
| `dumpLayout` | `(DumpLayoutOptions) => Promise<DumpLayoutResult>` | `uitest dumpLayout` → pruned, 0–1-normalized `LayoutNode` tree. |
| `parseBounds` / `pruneLayout` | — | Pure helpers behind `dumpLayout`. |

### hdc — input injection

| Export | Signature | Description |
| --- | --- | --- |
| `sendInput` | `(SendInputOptions) => Promise<void>` | One `uitest uiInput` action in **pixel** space (`InputType`: click/doubleClick/longClick/swipe/drag/fling/keyEvent/inputText). |
| `sendGesture` | `(SendGestureOptions) => Promise<void>` | Multi-`Waypoint` path; routes through `uinput` when `holdStartMs`/`holdEndMs` need real press timing. |
| `sendRawTouch` | `(SendRawTouchOptions) => Promise<void>` | Low-level `uinput -T` down/move/up events. |
| `buildInputCommand` / `buildGestureCommands` / `buildRawTouchCommand` | — | Pure command builders (unit-testable). |

### hdc — logging (hilog)

| Export | Signature | Description |
| --- | --- | --- |
| `waitForLog` | `(WaitForLogOptions) => Promise<HilogEntry>` | First entry matching a regex; auto-respawns the stream so it survives a reboot. |
| `watchLog` | `(WatchLogOptions) => Promise<HilogEntry[]>` | Collect matches for a duration (deduped by default). |
| `dumpLog` | `(DumpLogOptions) => Promise<HilogEntry[]>` | One-shot `hilog -x` filtered by domain/bundle/grep, capped to the last N lines. |
| `streamHilog` | `(StreamHilogOptions) => ChildProcessWithoutNullStreams` | Raw long-lived hilog stream (caller owns the process). |
| `setHilogLevel` | `(SetHilogLevelOptions) => Promise<void>` | Set the buffer level. |
| `parseHilogLine` / `dedupEntries` | — | Pure helpers; `HilogEntry` / `HilogLevel` types. |

### Build & dependencies

| Export | Signature | Description |
| --- | --- | --- |
| `buildHap` | `(BuildHapOptions) => Promise<BuildHapResult>` | High-level orchestration: ensure deps → `hvigorw` → discover built HAPs. The call most consumers want. |
| `runHvigorw` | `(RunHvigorwOptions) => Promise<RunHvigorwResult>` | Raw single `hvigorw` spawn. Parallel by default; `parallel: false` adds `--no-parallel`. |
| `buildHvigorwArgs` | `(opts) => string[]` | Pure argv builder (unit-testable). |
| `discoverHaps` | `(DiscoverHapsOptions) => Promise<Record<string, ModuleHaps>>` | Group `*-signed`/`*-unsigned` HAPs by module. |
| `runOhpm` / `ensureOhModules` | — | Run `ohpm`; install `--all` only when `oh_modules/` is missing. |
| `runCodelinter` / `parseCodelinterFindings` | — | Run the codelinter → `CodelinterResult { code, findings, raw }`. |

### Project scaffolding & inspection

| Export | Signature | Description |
| --- | --- | --- |
| `createScaffold` | `(CreateScaffoldOptions) => Promise<CreateScaffoldResult>` | Scaffold a project from a template; returns the created path. |
| `listTemplates` | `(templateRoot) => TemplateOption[]` | Enumerate templates under a caller-owned root. |
| `validateTemplateLayout` | `(templateDir, defaultModuleName) => string[]` | Missing required files, or `[]`. |
| `isValidProjectName` / `isValidBundleName` | `(s) => boolean` | Input validators. |
| `listModules` | `({ projectDir }) => ProjectModule[]` | `modules[]` from `build-profile.json5`. |
| `listAbilities` | `({ projectDir, moduleName? }) => AbilityInfo[]` | `abilities[]` from a module's `module.json5`. |
| `prepareSigning` | `(PrepareSigningOptions) => PrepareSigningResult` | No-op when signing material is present; otherwise generate it (`source: 'present' \| 'fresh'`). |
| `readJson5File` / `writeJson5File` / `readJsonFile` / `writeJsonFile` | — | JSON/JSON5 read/write helpers. |

### Device info

`getDeviceInfo(GetDeviceInfoOptions) => Promise<DeviceFullInfo>` collates device properties + display resolution. `dumpScreen` / `dumpWindow` / `dumpRenderService` wrap the corresponding `hidumper` services.

### Install orchestration

| Export | Signature | Description |
| --- | --- | --- |
| `applyChanges` | `(ApplyChangesOptions) => Promise<ApplyChangesResult>` | Install a HAP **and verify the process took it** — handles sign-info mismatch, asset-cache invalidation (reboot), and persistent-bundle restart. |
| `decideInstallMethod` / `decideReboot` | — | The pure (tested) decision functions behind `applyChanges`. |
| `diffHapAssets` / `diffEntryNames` | — | Diff two HAP archives' file manifests (drives the cache-invalidation reboot). |

## Conventions

- **Configuration.** Pass a `ConfigProvider`. `staticConfig({...})` is the quick path; a frontend can read settings, env vars, etc. Unset keys fall back to `defaultPaths`.
- **Logging & progress are opt-in.** Omit `logger`/`progress` for silence, or pass `consoleLogger` / your own. Nothing is written to `console` by default.
- **Device targeting.** Pass `deviceSerial` to address a specific target; omit it to use the default connected device. `selectDevice` additionally honors `ONIRO_DEVICE_SERIAL` / `DEVICE_SERIAL`.
- **Timeouts & cancellation.** Device ops take `timeoutMs` (sane per-op defaults) and `abortSignal`; aborting rejects with `CancelledError`.
- **Error model.** Exec primitives (`runProcess`/`hdcExec`/`shell`) resolve for any exit code — call `ensureOk` to throw `CommandFailedError`. Everything else throws a typed `OniroError` subclass.
- **No surprises in returns.** Functions return plain JSON-safe data; screenshots/bursts return raw `Buffer`s. No image decoding, no `sharp`-style dependency.
- **Pure helpers for testing.** Command/argv builders (`build*Command`, `buildHvigorwArgs`), parsers (`parse*`), and decision functions (`decide*`) are exported as side-effect-free functions.

## Related

- [`@oniroproject/oniro-app`](https://www.npmjs.com/package/@oniroproject/oniro-app) — the CLI built on this library.
- [Repository README](https://github.com/eclipse-oniro4openharmony/oniro-app-builder#readme) — workflow overview, Docker, and CI.

## License

Apache-2.0 — see [LICENSE](https://github.com/eclipse-oniro4openharmony/oniro-app-builder/blob/main/LICENSE).
