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
| `interface ConfigProvider` / `type ConfigKey` | `get(key, fallback)`. Keys: `sdkRootDir`, `cmdToolsPath`, `emulatorDir`, `hapPath`, `cmdToolsUrlLinux/Windows/Mac`, `emulatorUrl`, `tmpDir`, `sdkUrlBase`, `applicationCertPath`, `cacheDir`. |
| `staticConfig(values?)` | An in-memory `ConfigProvider` (expands `${userHome}`). For tests and as a base for frontend impls. |
| `defaultPaths` | The fallback values core uses when a key is unset. |
| `interface Logger` / `noopLogger` / `consoleLogger` | 4-level logger (`debug`/`info`/`warn`/`error`). Defaults to no-op. |
| `scopedLogger(logger, scope)` | Wrap a logger so every message is prefixed `[<scope>] `. |
| `interface ProgressReporter` / `ProgressUpdate` / `noopProgress` | `report({ message?, increment? })` for download/extract progress. |
| `interface Prompter` / `nonInteractivePrompter` | Interactive-prompt port; the non-interactive one throws on any prompt. |
| `interface OniroContext` / `defaultContext(overrides?)` | Bundles `{ logger, config }` for callers that prefer a context object. |

**Errors** — all extend `OniroError` (which carries an optional `cause`):

`OniroError` · `SdkNotInstalledError` · `CmdToolsNotInstalledError` · `UnsupportedPlatformError` · `ChecksumMismatchError` · `CancelledError` · `CommandFailedError` (carries `command`, `exitCode`, `stderr`) · `InsufficientSpaceError` (carries `dir`).

### SDK management

| Export | Signature | Description |
| --- | --- | --- |
| `downloadAndInstallSdk` | `(InstallSdkOptions) => Promise<void>` | Download + install an SDK release into `<sdkRootDir>/<os>/<api>`, reporting progress; `tmpDir` overrides the scratch directory (default: next to the install target). |
| `installSdkFromArchive` | `(InstallSdkFromArchiveOptions) => Promise<InstalledSdk>` | Install an SDK from a local `.tar.gz` (e.g. the full SDK from `OHOS_DAILY_BUILDS_URL`) into `<sdkRootDir>/<os>/<api>`, unpacking only the current OS's components and reading `api`/`version` from their `oh-uni-package.json`. Throws when that API is already installed unless `force`. |
| `getSupportedSdksForUi` | `(config) => SdkInfo[]` | Known SDKs annotated with `installed`, newest first. |
| `getHarmonyOsSdkListing` | `(config) => HarmonyOsSdkListing \| null` | The HarmonyOS SDK a HarmonyOS build would use, which `sdk install` does not manage: `{ flavour: 'HarmonyOS', displayName, version, api, installed, path, source }`. |
| `getInstalledSdks` | `(config) => string[]` | Versions with at least one OS-folder install. |
| `removeSdk` | `(config, api) => boolean` | Remove an installed SDK by API level across OS folders. |
| `detectProjectSdkVersion` | `(projectRoot, logger?) => number \| undefined` | Read `compileSdkVersion` from a project's `build-profile.json5`. |
| `ALL_SDKS` / `SdkRelease` | — | Catalog of known releases (`version`, `api`, `tarballStrip`, optional `archiveSuffix`). |
| `OHOS_URL_BASE` | — | Default SDK mirror base URL. |
| `getOsFolder()` / `getSdkFilename(version?)` | — | Map the host platform to its OS folder / SDK archive (`SdkArchiveInfo`). |

**Path resolvers** (all take `config`): `getSdkRootDir`, `getOhosBaseSdkHome`, `getCmdToolsPath`, `getEmulatorDir`, `getHdcPath`, `getOhpmPath`, `getCmdToolsBin(config, name?)`, `getHvigorwPath(config, projectDir)` (prefers the project-local wrapper only when it is structurally complete, else the bundled one).

**Download/archive primitives**: `downloadFile(DownloadOptions)` (rejects with `InsufficientSpaceError` when the advertised `content-length` does not fit on the destination filesystem), `verifySha256(file, sha256File)`, `extractZipWithProgress(ExtractZipOptions)` (Zip-Slip-safe), `extractTarball(tar, dest, strip?)`.

**Temporary space**: the installers download and extract in a scratch directory resolved as
`options.tmpDir` → `tmpDir` config key → `<installRoot>/.oniro-tmp`. The default sits next to the
install target so the finished tree is renamed into place instead of copied across a device
boundary, and so the system temp dir — a RAM-backed `tmpfs` on most Linux systems, too small for a
multi-GB archive — is never involved. `createInstallTempDir(opts)` (returns `{ dir, root }`, and
falls back to `os.tmpdir()` when the install parent is unwritable) and `removeTempWorkDir(dir, root?)`
are the pair the installers use; `resolveTmpRoot(config, override?, installRoot?)`,
`createTempWorkDir(root, prefix)`, `getFreeSpaceBytes(dir)`, `isRamBackedPath(dir)`,
`ensureFreeSpace(dir, bytes, what)`, `isOutOfSpaceError(err)`, `toSpaceError(err, tmpRoot, what)`
(turns an `ENOSPC` into an `InsufficientSpaceError` naming the directory and the remedy),
`formatBytes(n)`, `INSTALL_TMP_DIRNAME`, `TMP_DIR_HINT`.

### Command-line tools

| Export | Signature | Description |
| --- | --- | --- |
| `installCmdTools` | `(InstallCmdToolsOptions) => Promise<InstallCmdToolsResult>` | Install the tools by download or from a local zip (`localZipPath`); `tmpDir` overrides the scratch directory (default: next to the install target). The archive is staged inside the install directory and swapped in only once complete, so a failed install leaves the previous tools untouched (or rolls them back), and a successful one leaves exactly what a clean extraction holds. Returns `{ path, installed, previous? }` (`CmdToolsInfo`s); when it replaces an install it logs `describeReplacement(previous, installed)` before deleting the old one. |
| `describeReplacement` | `(previous, next: CmdToolsInfo) => string[]` | `Replacing command-line tools <old> with <new>.`, plus a line when hvigor changes major version, when the new release is older, and how to go back. `Reinstalling …` for the same release. |
| `getCmdToolsStatus` | `(config) => CmdToolsStatus` | `{ installed, status, path, hdc }`, and when installed `flavour`, `version`, the bundled `sdk` (`CmdToolsSdk`: `path`, `displayName`, `platformVersion`, `apiVersion`, `build`) and `tools` (e.g. `{ hvigor, ohpm, codelinter, hstack }`). |
| `readCmdToolsInfo` | `(cmdToolsPath) => CmdToolsInfo` | `{ version, flavour, sdk, tools }` from `version.txt` and `sdk/default/sdk-pkg.json`; unknown fields left out. |
| `describeCmdTools` | `({ version?, sdk?, tools? }) => string` | One line, e.g. `6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2)`. |
| `isCmdToolsInstalled` | `(config) => boolean` | — |
| `removeCmdTools` | `(config) => void` | Delete the install. |
| `getCmdToolsDownloadUrl` | `(config, platform?) => string` | Per-platform download URL (only Linux is public on the mirror). |
| `findCmdToolsSourceDir` | `(extractPath) => string` | Locate the tools root inside an extraction folder. |

### Signing

`java` must be on `PATH` (the OpenHarmony hap-sign-tool ships as a `.jar`).

| Export | Signature | Description |
| --- | --- | --- |
| `generateSigningConfigs` | `(GenerateSigningConfigsOptions) => GenerateSigningConfigsResult` | Generate keys/certs/material and write the `signingConfigs` block into `build-profile.json5`. Returns the `signaturesDir`, the signing `kind`, and a `SigningMaterialSummary` (profile type, apl, profile and certificate expiry). |
| `describeSigningMaterial` | `(SigningMaterialSummary) => string` | `release profile, apl normal; certificate valid until 2049-12-31 12:21 UTC`, as `sign` prints it. `signOpenHarmonyHap` returns the same summary as `material`. |
| `verifyHap` | `(VerifyHapOptions) => Promise<VerifyHapResult>` | Run `hap-sign-tool verify-app` on a HAP and report its `status` (`valid`/`invalid`/`unverified`), whether it is signed and the signature valid, the chain (leaf first, `CertificateInfo`) and root, the `signer` (`openharmony-dev`, `harmonyos-agc`, `other`), the profile (`HapProfileReport`: type, issuer, bundle, apl, app-feature, device count, validity, days left, whether its expiry is enforced and whether it names the signing certificate), and the `problems` that make it invalid. Never throws for a bad HAP. |
| `verifyHapExitCode` / `formatHapVerification` | `(VerifyHapResult) => number` / `=> string` | `0` valid, `1` invalid, `2` could not verify; the text `app verify` prints. |
| `findHapSignTool` | `(config, logger?) => string \| null` | The `hap-sign-tool.jar` of an installed OpenHarmony SDK, else the HarmonyOS SDK, else the command-line tools. |
| `pickSigningKind` | `(apl) => SigningKind` | `'profile-release'` for `normal`, `'application-release'` for `system_basic`/`system_core`. |
| `detectSigningConfigNames` | `(projectDir) => string[]` | The `products[*].signingConfig` names (falls back to `['default']`). |
| `createMaterial` / `getKey` / `encryptPwd` / `decryptPwd` | — | Signing-material key derivation + password encryption used in the profile. |
| `APL_VALUES` / `APP_FEATURE_VALUES` | — | Allowed values for `Apl` (`normal`/`system_basic`/`system_core`) and `AppFeature` (`hos_normal_app`/`hos_system_app`). |
| types | `GenerateSigningConfigsOptions`, `SigningPasswords`, `SigningKind`, `Apl`, `AppFeature` | `apl`, `appFeature`, `acls`, `passwords`, and `applicationCertPath` all default to the SDK's dev cert / `123456` keystore. |

### Emulator

| Export | Signature | Description |
| --- | --- | --- |
| `installEmulator` | `(InstallEmulatorOptions) => Promise<void>` | Download + extract the QEMU emulator into `emulatorDir`; `tmpDir` overrides the scratch directory (default: next to the install target). |
| `isEmulatorInstalled` / `removeEmulator` | `(config) => boolean` / `void` | — |
| `startEmulator` | `(StartEmulatorOptions) => Promise<void>` | Launch detached via `run.sh`/`run.bat`; optional `headless`, `logFile`, `connect`, `waitForHdcSeconds` and `waitReadySeconds` (waits for `bootevent.boot.completed` with `hdc tconn` only). Refuses while a pool instance runs. |
| `stopEmulator` | `(logger?) => Promise<void>` | Kill running emulator processes (every `qemu-system-x86_64`, pool instances included). |
| `getEmulatorStatus` | `(config, { address?, logger? }) => Promise<EmulatorStatus>` | `installed`, `running` (the default emulator; pool instances do not count), `connected`, and `instances`: the default emulator as instance 0, then every pool instance, each an `EmulatorInstanceStatus`. |
| `startPoolInstance` | `(StartPoolInstanceOptions) => Promise<EmulatorInstanceStatus>` | Emulator pool: launch instance `n` (1..99) with its own QEMU on qcow2 overlays of the images in `<emulatorDir>/instances/<n>/`, hdc on `127.0.0.1:55555+n`, VNC `5900+n`, serial `4444+n`. Options `smp` (2), `memory` (`2048M`), `resolution`, `headless` (true), `fresh`, `bootTimeoutSeconds` (300), `waitReadySeconds`, `qemuBin`, `qemuImg`, `accel`, `logFile`. Fails on a taken port, a running default emulator, or base images changed since the overlays were made. |
| `stopPoolInstance` | `({ config, instance, discard?, logger? }) => Promise<boolean>` | Signal only that instance's QEMU (by its recorded PID), `hdc tconn <addr> -remove`, and with `discard` delete its directory. |
| `getPoolInstanceStatus` / `listPoolInstanceStatuses` | `(config, n, opts?)` / `(config, opts?)` | Health of one or every pool instance: `stopped`, `booting`, `ready`, `hdc-lost`, `stuck` (`EmulatorHealth`), probing with `hdc tconn` and `param get bootevent.boot.completed`; records `readyAt` in `instance.json`. |
| `waitPoolInstanceReady` | `(WaitPoolInstanceReadyOptions) => Promise<EmulatorInstanceStatus>` | Poll until `ready`; throws on timeout or a dead QEMU. |
| `probeEmulatorBoot` / `classifyEmulatorHealth` | `(config, address, opts?)` / `(HealthInputs) => EmulatorHealth` | The probe and the pure health rule behind the above. |
| `poolInstancePorts` / `buildPoolQemuArgs` / `emulatorAccelArgs` | — | Pure helpers: an instance's ports, its QEMU argv, and the accelerator `run.sh` would pick. |
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
| `resolveDeviceSerial` / `hdcTargetArgsFor` | `(explicit?) => string \| undefined` / `(args, explicit?) => string[]` | The serial (explicit → `ONIRO_DEVICE_SERIAL` → none) and the `-t` prefix `hdcExec` uses; hdc server commands only take an explicit one. |
| `hdcClientFailure` | `(output) => string \| null` | The `[Fail]…` line hdc printed while exiting 0; `hdcExec` reports it as exit code 1. |
| `paramGet` / `paramSet` | `(config, key[, value], opts?) => Promise<…>` | Read/write system properties via `param get`/`set`. `paramGet` throws for an unset property. |
| `paramGetMany` | `(config, keys, opts?) => Promise<Record<string, string \| undefined>>` | Read several properties in one round trip. |

### hdc — files

`sendFile(SendFileOptions)` / `recvFile(RecvFileOptions)` — push/pull a file via `hdc file send`/`recv`. Local paths are normalised for hdc (`normaliseLocalPath`); a device path a Windows shell rewrote is rejected (`assertDevicePath`). `sendFile` with `bundle` writes into that app's sandbox (`appSandboxDir`) and chowns the file to the app.

### hdc — lifecycle & waiting

| Export | Signature | Description |
| --- | --- | --- |
| `reboot` | `(RebootOptions) => Promise<void>` | `system` (via `param set ohos.startup.powerctrl reboot`), `bootloader`, or `recovery`. Optionally waits for a bundle to return (and reconnects a TCP target across the reboot, restarting the hdc server if it keeps the dead session). |
| `waitForBundle` | `(WaitForBundleOptions) => Promise<void>` | Poll `pidof <bundle>` until it has a clean numeric pid. |
| `waitForBoot` | `(WaitForBootOptions) => Promise<void>` | Poll until reachable (and optionally `untilPidOf` has a pid). Tolerant of the reboot disconnect. |
| `waitForCondition` | `(WaitForConditionOptions) => Promise<void>` | Generic deadline + poll + heartbeat loop. A throwing probe counts as "not yet". |

### hdc — app install, launch & process

| Export | Signature | Description |
| --- | --- | --- |
| `installApp` | `(InstallAppOptions) => Promise<InstallAppResult>` | Install a `.hap` (`hapPath` / config / the signed entry HAP / the newest built one, unsigned as a last resort). Throws when the bundle manager rejects it, with the reason and the signing to do when it refuses an unsigned HAP (`unsignedHapRejection`). |
| `detectInstallFailure` / `ensureInstallOk` | — | Spot a bundle-manager rejection in `hdc install` output, which exits 0 either way. |
| `isBundleInstalled` | `(BundleOptions) => Promise<boolean>` | `bm dump -n` check. |
| `launchApp` | `(LaunchAppOptions) => Promise<void>` | `aa start` the entry ability (or an explicit `abilityName`). |
| `uninstallApp` / `forceStop` | `(BundleOptions) => Promise<void>` | Uninstall / force-stop by bundle name. |
| `findRunningProcess` | `(BundleOptions) => Promise<RunningProcess \| null>` | Non-throwing `pidof` check. |
| `listRunningProcesses` / `findAppProcessId` | — | `track-jpid`-based process listing / project-PID resolution. |
| `detectAaStartFailure` | `(output) => string \| null` | Detect a refused launch (`aa start` exits 0 even on failure). |
| `getBundleName` / `getMainAbility` | `(projectDir[, module?, ability?]) => string` | Read the bundle / resolve the launch ability from project manifests. |
| `smokeCheck` | `(SmokeCheckOptions) => Promise<SmokeResult>` | Smoke-check a just-launched app: wait for its pid, wait `delayMs` (default 2000), screenshot and judge it against a flat frame (needs a `decodeGreyscale` decoder, since core decodes no images), check the same pid is still running, and ask an optional `crashProbe({ config, bundle, since, deviceSerial, logger })` for a crash since launch. Returns `{ passed, failures, pid, alive, blankScreen, blankScore, screenshot, crash, crashChecked, … }`; never throws for a failed check. |
| `smokeVerdict` | `({ pid, alive, blankScreen, crash }) => { passed, failures }` | The pure verdict behind `smokeCheck`. |

### hdc — capture, display & UI dump

| Export | Signature | Description |
| --- | --- | --- |
| `takeScreenshot` | `(ScreenshotOptions) => Promise<Screenshot>` | `{ pixels: Buffer, width, height }` — raw JPEG, no decode. |
| `captureBurst` | `(CaptureBurstOptions) => Promise<Buffer[]>` | N frames `intervalMs` apart, pulled back in order. |
| `getDisplaySize` | `(config, opts?) => Promise<DisplaySize \| null>` | Render resolution from `hidumper` (no image work). |
| `dumpLayout` | `(DumpLayoutOptions) => Promise<DumpLayoutResult>` | `uitest dumpLayout` → pruned, 0–1-normalized `LayoutNode` tree, with `hint`, `disabled`, `hidden`, `covered` (painted over by a later filled layer), and `windowId` on each window's root. `detectKeyboard` adds `keyboard: KeyboardState`; `windowId` keeps one window (the screen is still dumped whole, so covering and the keyboard are judged on all of it). |
| `parseBounds` / `pruneLayout` / `findCoveredNodes` | — | Pure helpers behind `dumpLayout`. |
| `flattenLayout` / `findLayoutNodes` / `pickTarget` / `findVisibleMatch` | — | Pure: flatten a tree (nodes tagged with their `window` bundle and `windowId`), match an `ElementQuery` (a `LayoutSelector` — `text` / `id` / `type` — or a parsed `ElementSelector`), choose one uncovered, preferably clickable node (throws `TargetNotFoundError` with `reason` `none` / `covered` / `ambiguous`; a selector's `[n]` picks from all matches instead), and the first uncovered match (what `waitForTarget` polls for). |
| `listLayoutWindows` / `windowSubtree` / `rawWindowSubtree` / `windowNotFoundError` | — | Pure: the windows in a pruned tree (`LayoutWindow`: `windowId`, `bundle`, `b`), one window's part of a pruned or raw tree, and the error listing the on-screen windows. |
| `listWindows` / `parseWindowList` | `(ListWindowsOptions) => Promise<WindowInfo[]>` / `(text) => WindowInfo[]` | Every window from `hidumper -s WindowManagerService -a -a`: `id`, `name`, `pid`, `displayId`, `type`, `zOrder` (-1 = not shown), `rect`, `focused`. |
| `getImeBundles` / `parseImeBundles` / `findKeyboardWindow` | — | Installed input methods (`hidumper -s 3703`) and the soft-keyboard window in a layout. |

### hdc — element selectors

The `--selector` language of the CLI, evaluated over the pruned tree. All pure. The attribute DSL and the `xpath=` form follow openharmony-sig/deveco-cli (MIT); the XPath evaluator is a dependency-free subset (`/`, `//`, `*`, `.`, `..`, `[@a="v"]`, `[@a]`, `!=`, `contains` / `starts-with` / `ends-with` / `not` / `text()`, `and` / `or`, `[n]`, `[last()]`, `[position()<n]`, `(path)[n]`); anything else is a `SelectorParseError`.

| Export | Signature | Description |
| --- | --- | --- |
| `parseSelector` | `(text) => ElementSelector` | `xpath=<expr>` → `XPathSelector`; otherwise `key<op>value[,…][n]` → `DslSelector` (`clauses`, `index`: 0-based, negative from the end). Operators `=`, `*=`, `^=`, `$=`, `/=` (regex, `/flags`). Throws `SelectorParseError` (`position`, `input`) on bad syntax, an unknown key, or a repeated key. |
| `matchSelector` | `(tree, ElementSelector) => FlatLayoutNode[]` | Every match in paint order, window-tagged; the DSL index is left to the caller (`pickTarget`, `findVisibleMatch`). |
| `selectorFor` | `(tree, RecordedElement) => string` | The most specific stable selector for a recorded element (`Partial<FlatLayoutNode>`, e.g. from `wait --json`): `type` plus the first unique of `id`, `key`, `text`, `desc`, `hint`, then all of them, then all of them with `[n]`. Exact `=` clauses only; the result resolves back to that element. For record/replay. |
| `formatSelector` | `(clauses, index?) => string` | Render DSL clauses back to text `parseSelector` reads, quoting values as needed. |
| `clauseMatches` / `selectorAttribute` / `resolveSelectorKey` / `SELECTOR_KEYS` | — | One clause against a node; a key's value on a node (booleans as `"true"` / `"false"`; `key` falls back to `id`; `visible` = not `hidden` and not `covered`); key aliases (`description` → `desc`); the key list. |
| `parseXPath` / `evaluateXPath` | `(text) => XPathExpression` / `(tree, expr) => FlatLayoutNode[]` | The XPath subset on its own. Elements are named by component type (`node` when untyped). |
| `isElementSelector` / `ElementQuery` | — | Tell a parsed selector from a plain `LayoutSelector`; the union every target-taking function accepts. |
| `getImeBundles` / `parseImeBundles` / `findKeyboardWindow` | — | Installed input methods (`hidumper -s 3703`) and the soft-keyboard window in a layout. |
| `summarizeLayout` | `(DumpLayoutResult) => LayoutSummary` | Pure: per window (and in total) the element, content (text, description, placeholder or image), clickable and text-node counts. |
| `diffLayouts` | `(baseline, current) => LayoutDiff` | Pure: pair elements within a window by id, key, label and type, then type with overlapping boxes (greedy by IoU); report each pair's IoU and changed fields, the `missing` and `extra` elements, and a 0–1 `similarity`. |
| `parseLayoutBaseline` / `boxIoU` | — | Read a saved `dump layout` JSON (refuses a raw dump); IoU of two 0–1 boxes. |

### Image comparison

Pure functions over decoded greyscale pixels (`GreyImage`: `{ width, height, data: Uint8Array }`); the caller decodes the JPEG (the CLI uses sharp).

| Export | Signature | Description |
| --- | --- | --- |
| `pHash` / `dHash` | `(GreyImage) => string` | 64-bit DCT perceptual hash / difference hash, as 16 hex digits. |
| `hammingDistance` | `(a, b) => number` | Differing bits between two hashes. |
| `compareImages` | `(baseline, current) => ImageComparison` | `phashDistance`, `dhashDistance`, `pixelChangeRatio` (share of pixels that moved more than 24 grey levels), `sizeMismatch`, and `same` (both hashes within 4 bits and under 1 % changed). |
| `analyzeBlank` | `(GreyImage) => BlankAnalysis` | Whether a screenshot shows a blank app, status and navigation bars cropped off: blank when its pHash is within 10 bits of a flat frame's with a standard deviation of at most 10, or when 99.8 % of it is one colour. `blankScore` is that share. |
| `resizeGrey` / `cropRows` / `pixelChangeRatio` / `flatFrameHash` | — | The helpers behind them. |

### hdc — input injection

| Export | Signature | Description |
| --- | --- | --- |
| `sendInput` | `(SendInputOptions) => Promise<void>` | One `uitest uiInput` action in **pixel** space (`InputType`: click/doubleClick/longClick/swipe/drag/fling/keyEvent/inputText). `key` accepts names and combos (see `resolveKeyEvent`). |
| `performInput` | `(PerformInputOptions) => Promise<PerformInputResult>` | `sendInput` plus a start point from an element selector (`target`: a `LayoutSelector` or parsed `ElementSelector`, optionally limited to `windowId`), 0–1 fractions, or pixels; `clearText`, `inputText` with `clear`, and keyboard-aware `hideKeyboard`. |
| `locateTarget` | `(LocateTargetOptions) => Promise<LocatedTarget>` | Resolve a selector against the live layout (optionally one `windowId`) to one element and its pixel center, dismissing the keyboard if it hides the element. |
| `selectableTree` | `(DumpLayoutResult, windowId?) => LayoutNode` | What selectors search: the tree minus the soft-keyboard window, unless a window was asked for. |
| `hideKeyboard` | `(opts) => Promise<boolean>` | Press Back only when the soft keyboard is shown. |
| `waitForTarget` | `(WaitForTargetOptions) => Promise<FlatLayoutNode \| null>` | Poll the layout until an uncovered element matches (or, with `gone`, until none does); `windowId` limits it to one window, which counts as empty while it is not on screen. |
| `sendGesture` | `(SendGestureOptions) => Promise<void>` | Multi-`Waypoint` path; routes through `uinput` when `holdStartMs`/`holdEndMs` need real press timing. |
| `sendRawTouch` | `(SendRawTouchOptions) => Promise<void>` | Low-level `uinput -T` down/move/up events. |
| `buildInputCommand` / `buildGestureCommands` / `buildRawTouchCommand` / `resolveKeyEvent` | — | Pure command builders (unit-testable). |

### hdc — logging (hilog)

| Export | Signature | Description |
| --- | --- | --- |
| `waitForLog` | `(WaitForLogOptions) => Promise<HilogEntry>` | First entry matching a regex; auto-respawns the stream so it survives a reboot. |
| `watchLog` | `(WatchLogOptions) => Promise<HilogEntry[]>` | Collect matches for a duration (deduped by default). |
| `dumpLog` | `(DumpLogOptions) => Promise<HilogEntry[]>` | One-shot `hilog -x` filtered by domain/bundle/grep, capped to the last N lines. |
| `captureLog` | `(CaptureLogOptions) => Promise<CaptureLogResult>` | Stream hilog into a file until a deadline or abort, writing each line as it arrives and reconnecting after a reboot, so the small ring buffer cannot drop lines. |
| `streamHilog` | `(StreamHilogOptions) => ChildProcessWithoutNullStreams` | Raw long-lived hilog stream (caller owns the process). |
| `setHilogLevel` | `(SetHilogLevelOptions) => Promise<void>` | Set the buffer level. |
| `parseHilogLine` / `dedupEntries` | — | Pure helpers; `HilogEntry` / `HilogLevel` types. |

### Faultlogs (crashes and freezes)

Adapted in part from deveco-cli's `faultlog/` module (MIT); see `src/faultlog/NOTICE.md`.

| Export | Signature | Description |
| --- | --- | --- |
| `latestCrash` | `({ config, bundle?, since?, deviceSerial?, waitMs?, pollMs?, saveDir? }) => Promise<CrashVerdict \| null>` | The newest fault of `bundle` (any process when unset) since `since` (a `Date`, or seconds before the device clock), classified and parsed; null when there is none. `waitMs` keeps polling, since hiview writes the faultlog seconds after the process dies. `saveDir` saves the whole log and sets `rawPath`. |
| `analyzeFaultLog` | `(text, { name?, path?, rawPath? }) => CrashVerdict` | Pure: classify a faultlog (or faultloggerd crash record) and read `crashed`, `kind` (`cpp_crash`, `js_crash`, `app_freeze`, `sample_stack`, `unknown`), `subtype`, `confidence`, `bundle`, `pid`, `tid`, `time`, `reason`, `topFrame`, `projectFrame`, `file`/`line`/`column` of the first project ArkTS frame, `jsError {name, message, stack}`, `stack`, `nativeFrames`, `jsFrames`, `binderChain`, `deadlocks`, `notes`. |
| `listFaultLogs` | `(ListFaultLogsOptions) => Promise<FaultLogEntry[]>` | Newest first: `hidumper -s 1201 -a '-p Faultlogger -LogSuffixWithMs'` (else `ls /data/log/faultlog/faultlogger`), plus the `cppcrash-<pid>-<ms>.json` records in `/data/log/faultlog/temp` that hiview did not turn into a faultlog. Filters by `bundle` and `since`. |
| `readFaultLog` | `({ config, entry, deviceSerial? }) => Promise<string>` | A listed entry's text: `hidumper … -f <name>` without its banner, else `cat`. |
| `classifyFaultLog` | `(text) => FaultLogClassification` | Pure: the kind, confidence, completeness (`full` faultlog or `fragment`), evidence and excluded kinds, by structure alone. |
| `parseCppCrash` / `parseJsCrash` / `parseFreeze` / `parseBinder` / `buildPropagation` | — | The per-kind parsers and the binder-chain analysis behind `analyzeFaultLog`. |
| `parseNativeFrame` / `parseJsFrame` / `parseThreadStacks` | — | Frame parsers: `#00 pc … /system/lib64/x.so(sym+8)(buildid)` and `at f entry (entry/src/main/ets/x.ets:8:13)`. |
| `parseFaultLogList` / `parseFaultLogName` / `parseCrashRecordHeads` / `stripHidumperBanner` / `renderCrashJson` | — | Pure helpers for the device listing and the crash-record format. |

### Build & dependencies

| Export | Signature | Description |
| --- | --- | --- |
| `buildHap` | `(BuildHapOptions) => Promise<BuildHapResult>` | High-level orchestration: ensure deps → `hvigorw` → discover built HAPs. Throws `SdkNotInstalledError` (with the `version` to install) up front when an OpenHarmony project's SDK is missing, and `BuildFailedError { exitCode, failedTask, diagnostics, summary, rawTail, hint, sdk }` when ohpm or hvigor fails; a failed hvigor run's message ends naming the SDK used (`Built against …`). The result carries the build's warnings as `diagnostics` and the SDK as `sdk`. |
| `resolveBuildSdk({ config, projectDir, runtimeOS })` / `describeBuildSdk(sdk)` | The `BuildSdk` (`runtimeOS`, `displayName`, `version`, `api`, `path`) a build compiles against, found as the build finds it; `HarmonyOS 5.1.0 (API 18) at <path>`. |
| `signingMismatch(projectDir, runtimeOS, product?)` | Why the product's signingConfig holds material for the other runtime (HarmonyOS product without `type: "HarmonyOS"`, or the reverse), else undefined. `buildHap` adds it to `warnings` and as a `signing` warning diagnostic when a signed HAP was built. |
| `dependencyApiDiagnostic(diagnostics, sdkLabel, remedy)` / `ohModulesPackage(file)` | A `warning` `sdk` diagnostic when ArkTS errors under `oh_modules/` are missing properties or names (`Property … does not exist`, `Cannot find name`): a dependency may need a newer API level. Message-level only. |
| `buildWithDiagnostics` | `(BuildHapOptions) => Promise<BuildReport>` | `buildHap` that returns `ok: false` with the diagnostics instead of throwing for a failed build or a missing SDK (`missingSdk`), with the SDK used as `sdk`. Still throws when the build cannot run at all. The shape `build --json` prints. |
| `parseBuildOutput` | `(output, { projectDir? }) => ParsedBuildOutput` | Pure parser of hvigor output: ArkTS, hvigor, native (clang, lld) and ohpm errors as `BuildDiagnostic { severity, source, code, rule, message, file, line, column, task }`, de-duplicated, plus `failedTask` and hvigor's `COMPILE RESULT` counts. |
| `sdkTooOldDiagnostic` / `missingSdkSymbols` | — | The `sdk` diagnostic naming the installed API level that declares the kit symbols a build could not find. `diagnoseBuildFailure` gives the hint for other causes (system APIs, an SDK path hvigor cannot find). |
| `runHvigorw` | `(RunHvigorwOptions) => Promise<RunHvigorwResult>` | Raw single `hvigorw` spawn. Parallel by default; `parallel: false` adds `--no-parallel`. |
| `buildHvigorwArgs` | `(opts) => string[]` | Pure argv builder (unit-testable). |
| `discoverHaps` | `(DiscoverHapsOptions) => Promise<Record<string, ModuleHaps>>` | Group `*-signed`/`*-unsigned` HAPs by module, newest first. Test HAPs (`*-ohosTest-*.hap`, `isTestHap`) are left out. |
| `pickHap` | `(haps, module?) => PickedHap \| null` | The HAP to install: a signed one, else unsigned (`signed: false`). |
| `runOhpm` / `ensureOhModules` | — | Run `ohpm`; install `--all` only when `oh_modules/` is missing. |
| `runCodelinter` / `parseCodelinterReport` / `parseCodelinterFindings` | — | Run the codelinter → `CodelinterResult { code, findings, summary, notices, incomplete, raw }`; the parsers read its per-file table and `-Defects:` totals. |

### ArkTS check

| Export | Signature | Description |
| --- | --- | --- |
| `checkArkts` | `(ArktsCheckOptions) => Promise<ArktsCheckReport>` | Run the SDK's ArkTS checker and the project rules on a project or a list of files, without a build (`oniro-app check arkts`). `completed: false` with `error` when the checker could not run or crashed; throws only when the SDK cannot be resolved (`SdkNotInstalledError` for an API that is not installed). `fix: true` applies the verified fixes. Diagnostics use `BuildDiagnostic` with `source: 'arkts-check'`. |
| `resolveArktsCheckSdk` | `(config, projectDir, logger?) => ArktsCheckSdk` | The SDK directory the check loads: `<sdk home>/<compileSdkVersion>` for OpenHarmony, `default/openharmony` plus `default/hms/ets` of the located HarmonyOS SDK for HarmonyOS. |
| `parseArktsCheckOutput` / `arktsCheckerScript` | — | Read the checker's JSON; the path of the vendored `arkts-check.cjs`. |

### Screens

| Export | Signature | Description |
| --- | --- | --- |
| `inventoryScreens` | `(ScreensOptions) => ScreensInventory` | Static page and route inventory of every module (`oniro-app screens`): `pages` (`@Entry` pages from `main_pages.json` and `routeName`, `NavDestination`s from route maps and `.navDestination()` builders; `name`, `module`, `file`, `line`, `component`, `entry`, `kind`, `registered`, `contentNodes`, `routesOut`), `routes` (`router` and `NavPathStack` push/replace call sites and `loadContent`; `from`, `to`, `file`, `line`, `via`, `dynamic`), `placeholders` (`TODO`/`FIXME`, placeholder text, empty `build()`, pages without content), `warnings`. Synchronous, no SDK. Throws `OniroError` when the project cannot be read. |
| `checkScreensAgainstSpec` | `(inventory, { screens, routes, minContentNodes }) => ScreensSpecReport` | The G2 gate as a pure function of the inventory: every spec screen has a page with at least `minContentNodes` content nodes (per-screen override), every spec route (`{ from?, to }`) a push or replace call site. Returns `{ ok, screens, routes, failures }`, the matching page and call site for each. Names match a page's route name, its last path segment or its component, ignoring case. |
| `pagesMatching` | `(inventory, name) => ScreenPage[]` | The pages a spec name refers to, by that rule. |
| `scanEts` / `LAYOUT_COMPONENTS` | — | The ArkTS token scanner (comments, strings, templates, regex literals, matched brackets, declarations with decorators) the inventory uses; the components that do not count as content. |

### Doctor

| Export | Signature | Description |
| --- | --- | --- |
| `runDoctor` | `(DoctorOptions) => Promise<DoctorReport>` | Every `oniro-app doctor` check: `{ ok, checks: [{ id, status, detail, fix, fixed }], project, versions }`. Never throws for a failed check. `fix: true` installs the project's missing OpenHarmony SDK. |
| `checkCmdTools` / `checkCmdToolsFlavour` / `checkSigning` / `checkDisk` / `checkNode` | — | The synchronous checks, for a caller that wants one. `CMD_TOOLS_REQUIRED` lists what a complete tools install holds. |
| `describeProject` / `apiLevelOf` | — | A project's `runtimeOS`, SDK versions and minimum device API; the API level of `20` or `"6.0.0(20)"`. |
| `resolveProjectSdkDir` | `(config, projectDir) => string \| undefined` | The SDK API directory an OpenHarmony project builds against, under the SDK home or `local.properties` `sdk.dir`. |

### SDK declaration index

| Export | Signature | Description |
| --- | --- | --- |
| `loadApiIndex` | `(sdkDir, LoadApiIndexOptions?) => LoadedApiIndex` | The declaration index of one SDK API directory (`oniro-app api`): the cached one under `cacheDir` when it is current, else a new build that is then cached. The cache is keyed by the SDK directory and the mtimes of its `ets/` and `native/` `oh-uni-package.json`; `rebuild: true` forces a build. |
| `buildApiIndex` | `(sdkDir, BuildApiIndexOptions?) => ApiIndex` | Parse `ets/api/**`, `ets/arkts/**` and `ets/component/**` (`.d.ts`, `.d.ets`) with the SDK's bundled TypeScript (`ets/build-tools/ets-loader/node_modules/typescript`, else a resolvable `typescript`, or the one passed as `typescript`), map `ets/kits/@kit.*.d.ts` re-exports onto the symbols, and scan the Node-API headers (`native/sysroot/usr/include/{node_api*,js_native_api*}.h`, `napi/*.h`). Each `ApiEntry`: `name`, `qualifiedName`, `kind`, `language`, `module`, `kit`, `import`, `global`, `since`, `sinceText`, `deprecated`, `deprecatedSince`, `useInstead`, `syscap`, `systemApi`, `file`, `line`, `signature`, `doc`. |
| `searchApi` | `(index, query, ApiSearchOptions?) => ApiSearchResult` | Ranked token search: every word must match the name (exact > prefix > camelCase/snake_case part > substring), the owning class or namespace, or the doc line; a dotted word matches qualified names. Overloads fold into one hit (`overloads`). Filters: `kit`, `kinds`, `language`, `noDeprecated`, `noSystemApi`, `limit`. |
| `showApi` | `(index, symbol, opts?) => ApiShowResult` | Exact lookup by qualified name (`NavPathStack.pushPathByName`, `@Local`), else by dotted suffix; `found: false` when the SDK does not declare it. |
| `suggestApiSymbols` / `findApiInOtherSdks` | — | For a miss: the declared names closest to it, and the other installed SDKs that declare it (`[{ api, since }]`). |
| `resolveApiSdk` / `installedApiLevels` / `getApiIndexCacheDir` | — | The SDK to read (`sdkDir`, else `<sdk home>/<api>`, else the enclosing project's `compileSdkVersion`, else the newest installed); the installed API levels; the `cacheDir` config key (default `~/.oniro/cache`). |
| `serializeApiIndex` / `deserializeApiIndex` / `apiIndexCachePath` / `parseDocBlock` / `mergeDocBlocks` | — | The compact stored form, the cache file of an SDK, and the doc-comment tag reader. |

### Tests

| Export | Signature | Description |
| --- | --- | --- |
| `runTests` | `(RunTestsOptions) => Promise<TestRunReport>` | Build a module's main and `ohosTest` HAPs, install both, run `aa test` (Hypium's OpenHarmonyTestRunner) and parse it. `outcome` is `passed`, `failed` or `runner-error`; it does not throw for a failed case, build or run. Wakes and unlocks the screen first unless `wakeScreen: false`. |
| `parseTestOutput` | `(output) => ParsedTestOutput` | Pure parser of `aa test` output: cases with `status` and the raw `statusCode` (0 pass, -2 assertion failed, -1 threw), message, stack and duration; the `OHOS_REPORT_RESULT` summary; `TestFinished-ResultCode`/`-ResultMsg`; a dry run's case list. |
| `aaTestCommand` / `testHapPath` / `readTestModuleName` / `decideOutcome` | — | The pieces of `runTests`, exported for callers that drive the runner themselves. |
| `wakeAndUnlock` / `holdScreenOn` | — | Turn the screen on and swipe away a lock screen without a credential; keep the screen on (`power-shell timeout -o`) and restore it. |

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

`getDeviceInfo(GetDeviceInfoOptions) => Promise<DeviceFullInfo>` collates device properties (model, `osFamily` HarmonyOS / OpenHarmony, `osDistVersion`, API level, `abi`, `deviceType`, …) in one round trip, plus the display resolution. `dumpScreen` / `dumpWindow` / `dumpRenderService` wrap the corresponding `hidumper` services.

### Install orchestration

| Export | Signature | Description |
| --- | --- | --- |
| `applyChanges` | `(ApplyChangesOptions) => Promise<ApplyChangesResult>` | Install a HAP **and verify it took**: throws on a bundle-manager rejection or when `bm dump` does not list the bundle afterwards; handles sign-info mismatch, asset-cache invalidation (reboot), and persistent-bundle restart. |
| `decideInstallMethod` / `decideReboot` | — | The pure (tested) decision functions behind `applyChanges`. |
| `diffHapAssets` / `diffEntryNames` | — | Diff two HAP archives' file manifests (drives the cache-invalidation reboot). |

### HarmonyOS

HarmonyOS support is additive: a project is HarmonyOS only when its product declares
`runtimeOS: "HarmonyOS"`, and every OpenHarmony API behaves as before. `buildHap`,
`runHvigorw` and `createScaffold` pick the HarmonyOS SDK for such projects themselves.

| Export | Description |
| --- | --- |
| `detectRuntimeOs(projectDir, productName?)` | `'HarmonyOS'` or `'OpenHarmony'`, from `build-profile.json5`. |
| `findHarmonyOsSdk({ config, logger? })` / `requireHarmonyOsSdk(...)` | Locate a HarmonyOS SDK (`harmonyosSdkPath`, then DevEco Studio's default location, then `cmdToolsPath` when it is the HarmonyOS edition), with its release as `version`, e.g. `6.1.1(24)`, its `apiVersion` and its `source` (`configured`, `deveco-studio` or `cmdtools`); `null`, or an error naming `oniro-app cmdtools install`, when there is none. |
| `readSdkPkg(sdkPath)` | `SdkPkgInfo` (`displayName`, `version`, `platformVersion`, `apiVersion`, `build`) from `<sdkPath>/default/sdk-pkg.json`. |
| `harmonyOsSdkLabelForApi(api)`, `HARMONYOS_SDK_VERSIONS` | The `"<version>(<api>)"` label HarmonyOS products declare. |
| `createHarmonyOsSession(opts)` | `login` / `logout` / `getUserInfo` / `listTeams` / `resolveAgcAuth` / `getDeveloperAgreement` for a Huawei developer account. The token is stored encrypted, with the account's region. `onLoginUrl(url, { port })` reports the sign-in URL and loopback port. |
| `session.login(HarmonyOsLoginOptions)` | `timeoutMs`; `port` to listen on a fixed loopback port (for an `ssh -L` tunnel); `openBrowser: false` to leave opening the URL to the user; `pastedCallbacks`, an `AsyncIterable<string>` (e.g. a `readline` interface over stdin) of callback addresses pasted from a browser on another machine, checked like a request to the loopback port. |
| `harmonyOsAutoSign(opts)` | Keystore + CSR → AGC debug certificate → device registration → debug profile → `build-profile.json5`, reusing still-valid material. |
| `readProvisionProfile(path)` / `parseProvisionProfile(buffer)` | Type, issuer, bundle name, team, apl, app-feature, validity, devices, ACLs and certificates of a `.p7b`. |
| `describeProfileValidity(profile, now?)` / `formatUtc(date)` | `debug, valid until 2026-10-01 11:50 UTC`, as `sign --harmonyos` prints it. `harmonyOsAutoSign` and `harmonyOsSignHap` return the profile's `profileType` and `notAfter`. |
| `HUAWEI_SITES` | Each region's sign-in and AppGallery Connect hosts. |

```ts
import { createHarmonyOsSession, harmonyOsAutoSign, staticConfig } from '@oniroproject/core';

const config = staticConfig();
const session = createHarmonyOsSession({ config, onLoginUrl: (url) => console.log(url) });
if (!(await session.getUserInfo())) await session.login();

const result = await harmonyOsAutoSign({ config, session, projectDir: '/path/to/project' });
console.log(result.paths.profilePath, result.deviceIds);
```

Signing calls private, undocumented AppGallery Connect APIs, and needs a Huawei developer
account that is real-name verified or has accepted the HUAWEI Developer Basic Service
Agreement. Accounts from every region work: calls go to the account's own region, as in
DevEco Studio. Parts of this subtree are adapted from the MIT-licensed
`openharmony-sig/deveco-cli`; see [`src/harmonyos/NOTICE.md`](src/harmonyos/NOTICE.md).

## Conventions

- **Configuration.** Pass a `ConfigProvider`. `staticConfig({...})` is the quick path; a frontend can read settings, env vars, etc. Unset keys fall back to `defaultPaths`.
- **Logging & progress are opt-in.** Omit `logger`/`progress` for silence, or pass `consoleLogger` / your own. Nothing is written to `console` by default.
- **Device targeting.** Pass `deviceSerial` to address a specific target. Without it, every device operation addresses `ONIRO_DEVICE_SERIAL` / `DEVICE_SERIAL` when set, else hdc's single connected device. hdc's `[Fail]` lines (exit code 0 from hdc) surface as failures.
- **Timeouts & cancellation.** Device ops take `timeoutMs` (sane per-op defaults) and `abortSignal`; aborting rejects with `CancelledError`.
- **Error model.** Exec primitives (`runProcess`/`hdcExec`/`shell`) resolve for any exit code — call `ensureOk` to throw `CommandFailedError`. Everything else throws a typed `OniroError` subclass.
- **No surprises in returns.** Functions return plain JSON-safe data; screenshots/bursts return raw `Buffer`s. No image decoding, no `sharp`-style dependency.
- **Pure helpers for testing.** Command/argv builders (`build*Command`, `buildHvigorwArgs`), parsers (`parse*`), and decision functions (`decide*`) are exported as side-effect-free functions.

## Related

- [`@oniroproject/oniro-app`](https://www.npmjs.com/package/@oniroproject/oniro-app) — the CLI built on this library.
- [Repository README](https://github.com/eclipse-oniro4openharmony/oniro-app-builder#readme) — workflow overview, Docker, and CI.

## License

Apache-2.0 — see [LICENSE](https://github.com/eclipse-oniro4openharmony/oniro-app-builder/blob/main/LICENSE).
