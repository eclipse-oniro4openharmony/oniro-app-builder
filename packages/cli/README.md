# @oniroproject/oniro-app

Cross-platform command-line interface for **Oniro / OpenHarmony** application development. One binary drives the whole inner loop — install the SDK and toolchain, scaffold a project, sign and build it, boot the emulator, then install, launch, and drive the app over `hdc` — on Linux, macOS, and Windows.

It is built for **non-interactive use** (CI, scripts, agents): every command takes explicit flags, results print to **stdout** (plain text, or JSON with `--json`), progress and logs go to **stderr**, and the process exit code reflects success or failure. No prompts, no TTY assumptions.

This is the CLI frontend for [`@oniroproject/core`](https://www.npmjs.com/package/@oniroproject/core) — install that package instead if you want to call the same functionality from your own code (see its README for the API).

## Install

Requires **Node.js 20+**. For `oniro-app sign` you also need a **JDK** on `PATH` (`java`, `keytool`).

```bash
npm install -g @oniroproject/oniro-app
oniro-app --help
```

Global flags: `--version`, `--help`. Run `oniro-app <command> --help` for the authoritative, up-to-date flags of any command.

## Quick start

Set up the toolchain, scaffold an app, then build and run it on the emulator:

```bash
# One-time: toolchain + emulator
oniro-app sdk install 6.1
oniro-app cmdtools install
oniro-app emulator install

# Per project
oniro-app create --name HelloOniro --bundle com.example.hello \
                 --location ~/projects --sdk 23
cd ~/projects/HelloOniro
oniro-app sign
oniro-app build

# Run it
oniro-app emulator start --wait-for-hdc 300
oniro-app app install
oniro-app app launch
```

Once a device or emulator is connected you can inspect and drive it:

```bash
oniro-app devices --json
oniro-app screenshot -o shot.jpeg
oniro-app dump layout --json
oniro-app input --type click --x 200 --y 400
oniro-app watch --log 'error|fault' --for 5000 --json
```

## Command reference

### Environment & toolchain

Install commands are idempotent (they skip when already present); pass `--force` to reinstall.

#### `sdk` — manage OpenHarmony SDK installs

| Command | Description |
| --- | --- |
| `sdk install <version> [--force]` | Download and install an OpenHarmony SDK (e.g. `6.1`). |
| `sdk list [--json]` | List known SDK versions; an `*` marks installed ones. |
| `sdk remove <api>` | Remove an installed SDK by API level (e.g. `18`, `20`). |

#### `cmdtools` — manage the OpenHarmony command-line tools (provides `hvigorw`, `ohpm`, `hdc`, `codelinter`)

| Command | Description |
| --- | --- |
| `cmdtools install [--from-zip <path>] [--force]` | Install the tools. `--from-zip` installs from a local archive instead of downloading (required on Windows/macOS — see [Configuration](#configuration)). |
| `cmdtools status [--json]` | Report whether the tools are installed and their version. Exits non-zero when not installed. |
| `cmdtools remove` | Delete the configured command-line-tools directory. |

#### `emulator` — manage the Oniro emulator (QEMU-based)

| Command | Description |
| --- | --- |
| `emulator install [--force]` | Download and install the emulator. |
| `emulator start [options]` | Start the emulator via the bundled launcher and detach, so the CLI can exit while it keeps running. |
| `emulator stop` | Kill running emulator processes. |
| `emulator connect [--address <host:port>]` | Attempt an `hdc` connection (default `127.0.0.1:55555`). |
| `emulator remove` | Delete the configured emulator directory. |

`emulator start` options:

| Flag | Description |
| --- | --- |
| `--headless` | Launch headless (VNC + telnet serial, no local window). Required in CI. |
| `--log <path>` | Redirect launcher stdout/stderr to a file (default: discard). |
| `--wait-for-hdc <seconds>` | Block until `hdc` connects, up to N seconds. `0` (default) returns as soon as the launcher spawns. |
| `--connect <host:port>` | Override the launcher's hdc port-forward bind address. Pass `0.0.0.0:55555` on hosts where QEMU refuses to bind `127.0.0.1` (some CI runners). |

### Project lifecycle

#### `create` — scaffold a new app from a template

All flags are required except where a default is shown (non-interactive). On success the project path is printed to stdout.

| Flag | Description |
| --- | --- |
| `--name <name>` | Project folder name (letters, digits, `._-`, no slashes). |
| `--bundle <bundleName>` | Bundle name in reverse-DNS form, e.g. `com.example.myapp`. |
| `--location <dir>` | Parent directory the new project folder is created in. |
| `--sdk <api>` | Target SDK API level (e.g. `18`, `20`). |
| `--template <id>` | Template id (default `EmptyAbility`). |
| `--module <name>` | Module folder name (defaults to the template default, usually `entry`). |
| `--overwrite` | Replace the destination if it already exists. |

#### `templates` — inspect bundled templates

| Command | Description |
| --- | --- |
| `templates list [--json]` | List the project templates shipped with the CLI. |

#### `sign` — generate signing keys, certs, and `signingConfigs`

`sign [project-dir]` (defaults to the current directory). Requires `java` on `PATH`. Rewrites only the `signingConfigs` block of `build-profile.json5` (other keys are preserved). The generated profile uses the SDK's built-in development cert (`issuer=pki_internal`) and its validity window — **dev/local builds only, not distribution.** See [Signing apps that need system permissions](#signing-apps-that-need-system-permissions) for `--apl` / `--acls`.

| Flag | Description |
| --- | --- |
| `--apl <level>` | Ability Privilege Level: `normal` (default), `system_basic`, or `system_core`. |
| `--app-feature <feature>` | `hos_normal_app` or `hos_system_app`. Defaults follow `--apl`. |
| `--acls <list>` | Comma-separated permissions to write into the profile's `acls.allowed-acls`. |
| `--bootstrap` | No-op if signing material is already present; otherwise generate it. |
| `--store-password <pwd>` / `--key-password <pwd>` | Keystore passwords (default `123456`, the SDK keystore password). |

#### `build` — build the app via `hvigorw`

`build [project-dir]` (defaults to the current directory). Modules build in parallel by default.

| Flag | Description |
| --- | --- |
| `--product <product>` | hvigor product name (default `default`). |
| `--module <module>` | Restrict the build to a single module. |
| `--mode <mode>` | hvigor build mode (e.g. `release`, `debug`). |
| `--task <task>` | hvigor task to run (default `assembleHap`). |
| `--no-deps` | Skip the automatic `ohpm install --all` when `oh_modules/` is missing. |
| `--no-parallel` | Build modules serially. |
| `--json` | Emit the result (discovered HAPs grouped by module, warnings) as JSON. |

#### `lint` — run the OpenHarmony codelinter

`lint [project-dir]` (defaults to the current directory). Exits with the codelinter's exit code.

| Flag | Description |
| --- | --- |
| `--files <globs...>` | Specific files/globs to lint (default: the whole project). |
| `--json` | Emit findings as JSON. |

### Device & app

These commands target a connected device or emulator over `hdc`. Most accept `--device <serial>` to address a specific target; omit it to use the single connected device.

#### `devices` — list connected hdc devices

| Command | Description |
| --- | --- |
| `devices [--json]` | List connected targets (`serial`, connection, status). |

#### `app` — install, launch, and manage built apps

| Command | Description |
| --- | --- |
| `app install [project-dir] [--hap <path>]` | Install the signed `.hap` via `hdc`. `--hap` overrides the resolved path. |
| `app launch [project-dir] [--module <m>] [--ability <name>]` | Launch the app. `--ability` defaults to the module's `mainElement` / first visible ability. |
| `app apply [project-dir] --bundle <b> [options]` | Install a HAP **and verify the running process took the change** — handles sign-info mismatch, asset-cache invalidation, and persistent-bundle restart. |
| `app uninstall <bundle> [--device <serial>]` | Uninstall an app by bundle name. |
| `app stop <bundle> [--device <serial>]` | Force-stop an app by bundle name. |

`app apply` options:

| Flag | Description |
| --- | --- |
| `--bundle <bundle>` | **Required.** Bundle to apply changes to. |
| `--module <module>` | Module to resolve the HAP from (multi-module projects). |
| `--hap <path>` | Explicit `.hap` path (else resolved from the project + module). |
| `--installed-hap <path>` | Local copy of the currently-installed HAP, to enable the asset-cache reboot diff. |
| `--system` | Treat as a persistent/system bundle (refuses to uninstall on a sign-info mismatch). |
| `--allow-uninstall` | Permit uninstalling a system bundle on sign-info mismatch (dangerous). |
| `--json` | Emit the result (`method`, pre/post-install pid, `cacheCleared`) as JSON. |

#### `file` — transfer files to/from the device

| Command | Description |
| --- | --- |
| `file send <local> <remote> [--device <serial>]` | Push a local file to the device. |
| `file recv <remote> <local> [--device <serial>]` | Pull a file from the device. |

#### `reboot` — reboot the device

| Flag | Description |
| --- | --- |
| `--mode <mode>` | `system` (default), `bootloader`, or `recovery`. |
| `--wait-bundle <bundle>` | After a system reboot, wait until this bundle is running again. |
| `--timeout <ms>` | Max time to wait for the bundle (default `180000`). |
| `--device <serial>` | Target device serial. For a TCP target (an emulator at `host:port`), passing this reconnects the session across the reboot. |

#### `wait` — wait for a device condition

Specify exactly one of `--log`, `--boot`, or `--bundle`.

| Flag | Description |
| --- | --- |
| `--log <pattern>` | Resolve when a hilog line (`tag: message`) matches this regex. |
| `--boot` | Resolve when the device is reachable. |
| `--bundle <bundle>` | With `--log`: filter to this bundle. Alone: wait until this bundle is running. |
| `--pid-of <name>` | With `--boot`: also require this process to have a pid. |
| `--domain <domain>` | With `--log`: hilog domain filter (e.g. `0xD003900`). |
| `--timeout <ms>` | Max wait (default `30000`). |
| `--device <serial>` | Target device serial. |
| `--json` | With `--log`: emit the matched entry as JSON. |

#### `watch` — collect matching hilog lines for a fixed duration

| Flag | Description |
| --- | --- |
| `--log <pattern>` | **Required.** Regex tested against each line (`tag: message`). |
| `--for <ms>` | Duration to watch (default `10000`). |
| `--bundle <bundle>` | Filter to this bundle. |
| `--domain <domain>` | hilog domain filter. |
| `--no-dedup` | Do not collapse consecutive duplicate lines. |
| `--device <serial>` | Target device serial. |
| `--json` | Emit the collected entries as JSON. |

#### `screenshot` — capture the screen as a JPEG

Writes raw JPEG bytes to a file (no grid overlay — that lives in the MCP layer).

| Flag | Description |
| --- | --- |
| `-o, --output <file>` | Output path (default `screenshot.jpeg`). |
| `--burst <count>` | Capture N frames; writes `<base>-<i><ext>`. |
| `--interval <ms>` | Delay between burst frames (default `50`). |
| `--device <serial>` | Target device serial. |

#### `dump` — dump device state as JSON

| Command | Description |
| --- | --- |
| `dump [layout]` | Dump the on-screen UI layout (the default and currently only target) as a pruned, 0–1-normalized tree to stdout. |

| Flag | Description |
| --- | --- |
| `--bundle <bundle>` | Filter the layout to a single window/bundle. |
| `--raw` | Return the unpruned tree. |
| `--device <serial>` | Target device serial. |

#### `input` / `gesture` — inject UI input

`input` injects a single event in **pixel** coordinates via `uitest uiInput`:

| Flag | Description |
| --- | --- |
| `--type <type>` | **Required.** One of `click`, `doubleClick`, `longClick`, `swipe`, `drag`, `fling`, `keyEvent`, `inputText`. |
| `--x <px>` / `--y <px>` | Start coordinate (click / swipe start). |
| `--x2 <px>` / `--y2 <px>` | End coordinate (swipe / drag / fling). |
| `--speed <px-per-s>` | Velocity for swipe / drag / fling. |
| `--key <key>` | Key id or symbolic name (`Back` / `Home` / `Power`) for `keyEvent`. |
| `--text <text>` | Text for `inputText`. |
| `--device <serial>` | Target device serial. |

`gesture` injects a multi-waypoint path:

| Flag | Description |
| --- | --- |
| `--waypoints <json>` | **Required.** JSON array of pixel waypoints `[{"x":..,"y":..,"t":..}]` (`t` = ms from start). |
| `--hold-start <ms>` / `--hold-end <ms>` | Hold at the first/last point before moving/lifting (routes via `uinput`). |
| `--device <serial>` | Target device serial. |

```bash
oniro-app gesture --waypoints '[{"x":200,"y":600,"t":0},{"x":200,"y":200,"t":400}]'
```

## Output & exit codes

- **Results → stdout.** Plain text by default; `--json` (where supported) writes `JSON.stringify(..., null, 2)`. Read/observe commands (`sdk list`, `cmdtools status`, `templates list`, `devices`, `wait --log`, `watch`, `lint`, `app apply`, `build`) accept `--json`; `dump` always emits JSON; action-only commands do not.
- **Progress & logs → stderr.** stdout stays clean for machine consumers, so `oniro-app create … > path.txt` or `oniro-app devices --json | jq` work cleanly.
- **Exit code.** `0` on success, non-zero on failure (the error message is written to stderr). Set `ONIRO_DEBUG=1` to also print full stack traces.

## Configuration

The CLI reads paths and URLs from environment variables. All are optional; defaults match the layout used historically by this project. `${userHome}` inside any value expands to the current user's home directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ONIRO_SDK_ROOT_DIR` | `~/setup-ohos-sdk` | SDK install root |
| `ONIRO_CMD_TOOLS_PATH` | `~/command-line-tools` | Command-line tools install root |
| `ONIRO_EMULATOR_DIR` | `~/oniro-emulator` | Emulator install root |
| `ONIRO_HAP_PATH` | `entry/build/.../entry-default-signed.hap` | Default `.hap` used by `app install` (relative to the project) |
| `ONIRO_SDK_URL_BASE` | `https://repo.huaweicloud.com/openharmony/os` | Base URL for SDK downloads (point at a private/CI mirror) |
| `ONIRO_CMD_TOOLS_URL_LINUX` | Huawei mirror, x64 5.1.0.840 | Override the Linux cmd-tools URL |
| `ONIRO_CMD_TOOLS_URL_WINDOWS` | (unset) | Self-hosted Windows cmd-tools URL |
| `ONIRO_CMD_TOOLS_URL_MAC` | (unset) | Self-hosted macOS cmd-tools URL |
| `ONIRO_EMULATOR_URL` | Latest `oniro_emulator.zip` | Emulator download URL |
| `ONIRO_APPLICATION_CERT_PATH` | (unset) | External application-cert chain to use when signing system apps |
| `ONIRO_DEBUG` | (unset) | Set to `1` for full stack traces on error |

**Command-line tools on Windows / macOS.** The Huawei mirror only publishes a Linux build of the command-line tools. On Windows and macOS you must either download the ZIP manually from the Huawei developer portal and install it with `oniro-app cmdtools install --from-zip path/to/commandline-tools-<platform>.zip`, or host the archive yourself and set `ONIRO_CMD_TOOLS_URL_WINDOWS` / `ONIRO_CMD_TOOLS_URL_MAC` so `cmdtools install` can fetch it.

## Signing apps that need system permissions

`oniro-app sign` defaults to `--apl normal` / `--app-feature hos_normal_app`, which is fine for ordinary apps. Apps that request permissions above `normal` (anything with `system_basic` or `system_core` availability — e.g. `ohos.permission.GET_WIFI_INFO_INTERNAL`, `ohos.permission.ACCESS_PIN_AUTH`) need a higher APL, otherwise `bm install` fails with `grant request permissions failed`.

```bash
oniro-app sign --apl system_basic           # implies --app-feature hos_system_app
oniro-app sign --apl system_core            # implies --app-feature hos_system_app
oniro-app sign --apl system_basic --app-feature hos_normal_app  # explicit override
```

When `--apl` is `system_basic` or `system_core`, the HAP signing key automatically switches from `OpenHarmony Application Profile Release` to `OpenHarmony Application Release`, and the profile's `distribution-certificate` is set to the matching CA-signed `OpenHarmony Application Release` leaf (shipped as a code resource — the SDK only bundles the Profile Release chain). This matches the convention used by every preinstalled OpenHarmony system app's `signature/` directory and is required to get past BMS's parse-profile-prop check on install.

Some privileged permissions (e.g. `ohos.permission.REBOOT`, `ohos.permission.INJECT_INPUT_EVENT`, `ohos.permission.CAPTURE_SCREEN`) must additionally appear in the profile's `acls.allowed-acls`. Pass them via `--acls`:

```bash
oniro-app sign --apl system_core \
    --acls ohos.permission.REBOOT,ohos.permission.INJECT_INPUT_EVENT
```

The `signingConfigs` block written to `build-profile.json5` mirrors the names used by the project's `products[*].signingConfig` (e.g. `applications/standard/systemui` uses `release`, `launcher` uses `default`). If the project has no products section, `default` is used.

## Programmatic use

Everything the CLI does is exposed as a library by [`@oniroproject/core`](https://www.npmjs.com/package/@oniroproject/core), so you can embed the same SDK/build/sign/emulator/`hdc` functionality in an editor extension, an MCP server, or your own tooling. See that package's README for the API reference.

## License

Apache-2.0 — see [LICENSE](https://github.com/eclipse-oniro4openharmony/oniro-app-builder/blob/main/LICENSE).
