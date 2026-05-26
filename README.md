# Oniro App Builder

Cross-platform tooling for Oniro/OpenHarmony app development. This monorepo ships two npm packages:

- **`@oniroproject/core`** — vscode-agnostic library wrapping SDK install, build, sign, emulator, hdc, and project scaffolding.
- **`@oniroproject/oniro-app`** — the `oniro-app` CLI built on top of the core. Non-interactive by design: every command takes explicit flags, results go to stdout, progress/logs go to stderr, and exit codes reflect success/failure.

The CLI runs on Linux, macOS, and Windows. Anything in the OpenHarmony app-development inner loop (SDK install → sign → build → install on device → launch) can be driven from `oniro-app`; nothing in this repo touches firmware or device images.

## Install

Requires Node.js 20+ and (for `oniro-app sign`) a JDK on PATH (`java` / `keytool`).

```bash
$ npm install -g @oniroproject/oniro-app
$ oniro-app --help
```

## CLI usage

```text
oniro-app sdk install <version> [--force]     Install an OpenHarmony SDK
oniro-app sdk list [--json]                   List known SDKs (installed flag included)
oniro-app sdk remove <api>                    Remove an installed SDK by API level
oniro-app cmdtools install [--force]          Install hvigorw/ohpm/hdc command-line tools
oniro-app cmdtools status [--json]            Report cmd-tools install state + version
oniro-app cmdtools remove                     Delete the cmd-tools install
oniro-app emulator install [--force]          Install the QEMU-based Oniro emulator
oniro-app emulator start [--no-wait]          Start the emulator (waits for hdc by default)
oniro-app emulator stop                       Kill running emulator processes
oniro-app emulator connect [--address <a>]    Attempt hdc connect
oniro-app emulator remove                     Delete the emulator install
oniro-app sign [project-dir] [--apl <level>] [--app-feature <feature>] [--acls <list>]
                                              Generate signing configs + write build-profile.json5
oniro-app build [project-dir] [--product <p>] [--module <m>] [--mode <m>] [--task <t>]
oniro-app app install [project-dir] [--hap <p>]  Install the signed .hap on device/emulator via hdc
oniro-app app launch  [project-dir] [--module <m>]  Launch the app via hdc
oniro-app create --name <n> --bundle <b> --location <d> --sdk <api>
                 [--template <id>] [--module <m>] [--overwrite]
oniro-app templates list [--json]             List bundled project templates
```

Every install command is idempotent (skips if already installed) and takes `--force` to reinstall.

### Configuration

The CLI reads paths and URLs from environment variables. All are optional; defaults match the layout used historically by this project.

| Variable                       | Default                            | Purpose                              |
| ------------------------------ | ---------------------------------- | ------------------------------------ |
| `ONIRO_SDK_ROOT_DIR`           | `~/setup-ohos-sdk`                 | SDK install root                     |
| `ONIRO_CMD_TOOLS_PATH`         | `~/command-line-tools`             | Command-line tools install root      |
| `ONIRO_EMULATOR_DIR`           | `~/oniro-emulator`                 | Emulator install root                |
| `ONIRO_HAP_PATH`               | `entry/build/.../entry-default-signed.hap` | Path used by `app install` (relative to project)  |
| `ONIRO_CMD_TOOLS_URL_LINUX`    | Huawei mirror, x64 5.1.0.840       | Override the Linux cmd-tools URL     |
| `ONIRO_CMD_TOOLS_URL_WINDOWS`  | (unset — see note below)           | Self-hosted Windows cmd-tools URL    |
| `ONIRO_CMD_TOOLS_URL_MAC`      | (unset — see note below)           | Self-hosted macOS cmd-tools URL      |
| `ONIRO_EMULATOR_URL`           | Latest oniro_emulator.zip          | Emulator download URL                |
| `ONIRO_DEBUG`                  | unset                              | Set to `1` for full stack traces     |

`${userHome}` inside any of these values is expanded to the current user's home directory.

**Command-line tools on Windows / macOS.** The Huawei mirror only publishes a Linux build of the OpenHarmony command-line tools. On Windows and macOS you must either:

1. Download the ZIP manually from the Huawei developer portal and install it:
   ```bash
   $ oniro-app cmdtools install --from-zip path/to/commandline-tools-<platform>.zip
   ```
2. Host the archive yourself and set `ONIRO_CMD_TOOLS_URL_WINDOWS` / `ONIRO_CMD_TOOLS_URL_MAC` so `oniro-app cmdtools install` can fetch it automatically.

### Signing apps that need system permissions

`oniro-app sign` defaults to `--apl normal` / `--app-feature hos_normal_app`, which is fine for ordinary apps. Apps that request permissions above `normal` (anything with `system_basic` or `system_core` availability — e.g. `ohos.permission.GET_WIFI_INFO_INTERNAL`, `ohos.permission.ACCESS_PIN_AUTH`) need a higher APL, otherwise `bm install` fails with `grant request permissions failed`.

```bash
$ oniro-app sign --apl system_basic           # implies --app-feature hos_system_app
$ oniro-app sign --apl system_core            # implies --app-feature hos_system_app
$ oniro-app sign --apl system_basic --app-feature hos_normal_app  # explicit override
```

When `--apl` is `system_basic` or `system_core`, the HAP signing key automatically switches from `openharmony application profile release` to `OpenHarmony Application Release`, and the profile's `distribution-certificate` is set to the matching CA-signed `OpenHarmony Application Release` leaf (shipped as a code resource — the SDK only bundles the Profile Release chain). The change matches the convention used by every preinstalled OpenHarmony system app's `signature/` directory and is required to get past BMS's parse-profile-prop check on install.

Some privileged permissions (e.g. `ohos.permission.REBOOT`, `ohos.permission.INJECT_INPUT_EVENT`, `ohos.permission.CAPTURE_SCREEN`) must additionally appear in the profile's `acls.allowed-acls`. Pass them via `--acls`:

```bash
$ oniro-app sign --apl system_core \
    --acls ohos.permission.REBOOT,ohos.permission.INJECT_INPUT_EVENT
```

The `signingConfigs` block written to `build-profile.json5` mirrors the names used by the project's `products[*].signingConfig` (e.g. `applications/standard/systemui` uses `release`, `launcher` uses `default`). If the project has no products section, `default` is used.

The generated profile uses the SDK's bundled development cert (`issuer=pki_internal`) and inherits the SDK's validity window — suitable for local/dev installs, not for distribution. Running `sign` rewrites the `signingConfigs` block of `build-profile.json5` (other keys are preserved).

## Typical workflow

```bash
$ oniro-app sdk install 6.1
$ oniro-app cmdtools install
$ oniro-app create --name HelloOniro --bundle com.example.hello \
                   --location ~/projects --sdk 23
$ cd ~/projects/HelloOniro
$ oniro-app sign
$ oniro-app build
$ oniro-app emulator install
$ oniro-app emulator start
$ oniro-app app install
$ oniro-app app launch
```

## Docker

The repo ships a Dockerfile that produces a self-contained image with the CLI + SDK + cmd-tools pre-installed:

```bash
$ docker build --build-arg ONIRO_SDK_VERSION=6.1 -t oniro-app .
$ docker run --rm -v $(pwd):/workspace oniro-app build     # or sign / sdk list / app install ...
```

Drop into an interactive shell if you want to inspect the environment:

```bash
$ docker run --rm -it -v $(pwd):/workspace --entrypoint bash oniro-app
```

The image bakes the SDK and command-line tools into `/opt/oniro/` and exports `ONIRO_SDK_ROOT_DIR` / `ONIRO_CMD_TOOLS_PATH` to point at them — overridable at `docker run` time via `-e`.

## Repo layout

```
packages/
├── core/      # @oniroproject/core — shared library (no vscode deps)
└── cli/       # @oniroproject/oniro-app — the oniro-app binary, ships templates/
Dockerfile     # container image: node:20-slim + JDK + oniro-app + SDK preinstall
.github/workflows/
├── ci.yml              # cross-OS matrix for the CLI's own typecheck/build/test + docker build
├── scaffold-app.yml    # reusable: `oniro-app create` → upload project as artifact
├── build-app.yml       # reusable: download project → sign + build → upload signed .hap + toolchains
├── emulator-run.yml    # reusable: download .hap + toolchains → install + launch in QEMU → screenshot
└── test-sample-app.yml # orchestrator: chains the three reusable workflows on push/PR
```

## Development

```bash
$ npm install
$ npm run build       # builds both packages
$ npm test            # runs vitest suites
$ npm run typecheck
```

The CLI can be exercised directly during development with `node packages/cli/dist/oniro-app.js <subcommand>`, or globally via `npm install -g ./packages/cli` after the first build.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs the inner loop (typecheck, build, unit tests) on Linux, macOS, and Windows for every push and PR — the cross-platform contract is enforced there.

End-to-end CI is split into three composable reusable workflows, chained by [`test-sample-app.yml`](.github/workflows/test-sample-app.yml):

1. **[`scaffold-app.yml`](.github/workflows/scaffold-app.yml)** — runs `oniro-app create` against the bundled `EmptyAbility` template and uploads the project tree as an artifact. Inputs: `project_name`, `bundle_name`, `sdk_api`, `template`, `module_name`, `project_artifact`.
2. **[`build-app.yml`](.github/workflows/build-app.yml)** — downloads any project artifact (it doesn't have to come from `scaffold-app.yml`; a checked-in project would work too), installs the SDK + cmd-tools (cached across runs), signs and builds, uploads the resulting `.hap` and toolchains. Outputs: `hap_file`, `hap_artifact`, `toolchains_artifact`.
3. **[`emulator-run.yml`](.github/workflows/emulator-run.yml)** — downloads the `.hap` and toolchains artifacts, launches the QEMU-based Oniro emulator headless, installs and launches the app via hdc, captures a VNC screenshot.

Each step exercises one logical concern of the CLI (create / sign+build / install+launch), so a failure in one stage points at one CLI command instead of a giant monolithic job. Final artifacts: `scaffolded-app`, `built-hap`, `toolchains`, `emulator-screenshot`.

## Contribution

Pull requests and issues welcome.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
