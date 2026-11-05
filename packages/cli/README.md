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
oniro-app dump layout --flat
oniro-app input --type click --target "Sign in"
oniro-app watch --log 'error|fault' --for 5000 --json
```

## Command reference

### Environment & toolchain

Install commands are idempotent (they skip when already present); pass `--force` to reinstall.

#### `sdk` — manage OpenHarmony SDK installs

HarmonyOS SDKs are not managed here: they ship inside the HarmonyOS command-line tools (see `cmdtools` below) or DevEco Studio.

| Command | Description |
| --- | --- |
| `sdk install <version> [--force] [--tmp-dir <path>]` | Download and install an OpenHarmony SDK (e.g. `6.1`). `--tmp-dir` overrides where download/extract temporaries go (see [Temporary space](#temporary-space)). |
| `sdk install --from-archive <path> [--force] [--tmp-dir <path>]` | Install an SDK from a local `.tar.gz` instead, such as the [full SDK](#full-sdk). Only the current OS's components are unpacked, and the API level is read from them; an SDK already installed at that level is replaced only with `--force`. |
| `sdk list [--json]` | List known OpenHarmony SDK versions; an `*` marks installed ones. Then it says HarmonyOS SDKs come with the command-line tools and lists the HarmonyOS SDK a HarmonyOS build would use and where it came from, or names `oniro-app cmdtools install` when there is none. `--json` adds `flavour: "OpenHarmony"` to each release and appends the HarmonyOS SDK as `{ flavour: "HarmonyOS", displayName, version, api, installed, path, source }`, `source` being `cmdtools`, `deveco-studio` or `configured` (ONIRO_HARMONYOS_SDK_PATH). |
| `sdk remove <api>` | Remove an installed SDK by API level (e.g. `18`, `20`). |

##### Full SDK

`sdk install <version>` downloads the public SDK, which leaves out system APIs (`@systemapi`). The full SDK is not on the release mirror: download an `ohos-sdk-full` archive from the [OpenHarmony daily builds](https://dcp.openharmony.cn/workbench/cicd/dailybuild/dailylist) and install it from the file:

```bash
oniro-app sdk install --from-archive ~/Downloads/version-Master_Version-OpenHarmony_7.0.0.39-…-ohos-sdk-full_7.0-Release.tar.gz
```

It lands in `<ONIRO_SDK_ROOT_DIR>/<os>/<api>` like a downloaded release, so projects with that `compileSdkVersion` build against it. Pass `--force` to replace a public SDK of the same API level, or set `ONIRO_SDK_ROOT_DIR` to a separate root to keep both.

#### `cmdtools` — manage the command-line tools (provides `hvigorw`, `ohpm`, `hdc`, `codelinter` and, in the HarmonyOS edition, the HarmonyOS SDK)

| Command | Description |
| --- | --- |
| `cmdtools install [--from-zip <path>] [--force] [--tmp-dir <path>]` | Install the tools. `--from-zip` installs from a local archive instead of downloading (required on Windows/macOS — see [Configuration](#configuration)); `--tmp-dir` overrides where download/extract temporaries go (see [Temporary space](#temporary-space)). The new tools are staged and swapped in only once complete: an install that fails (a full disk, say) leaves the existing tools as they were, and a successful one replaces the directory's contents outright. Without `--force`, existing tools are left alone and named (`Command-line tools 6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2) already installed at …`). With it, before the old tools are deleted, it prints what replaces what, e.g. `Replacing command-line tools 5.1.0.840 (HarmonyOS 5.1.0, API 18, hvigor 5.18.5) with 6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2).`, and says when hvigor changes major version or the new release is older. These tools serve every project on the machine, and newer releases are only on the Huawei developer portal, so keep the old ZIP to go back. |
| `cmdtools status [--json]` | Report whether the tools are installed and what they are, e.g. `Installed 6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2)`, then their path, their flavour (`HarmonyOS` when they bundle `sdk/default/hms`, as the Huawei developer-portal download does, else `OpenHarmony`), the SDK they bundle (name, API level, build and path; in the HarmonyOS edition, the SDK HarmonyOS builds use), the hvigor version, and the `hdc` binary every device command uses. `--json` carries the same as `version`, `flavour`, `sdk` (`path`, `displayName`, `platformVersion`, `apiVersion`, `build`) and `tools` (`hvigor`, `ohpm`, `codelinter`, `hstack`, as `version.txt` lists them), with `installed`, `status`, `path` and `hdc`. Exits non-zero when not installed. |
| `cmdtools remove` | Delete the configured command-line-tools directory. |

#### `emulator` — manage the Oniro emulator (QEMU-based)

| Command | Description |
| --- | --- |
| `emulator install [--force] [--tmp-dir <path>]` | Download and install the emulator. `--tmp-dir` overrides where the downloaded ZIP goes (see [Temporary space](#temporary-space)). |
| `emulator start [options]` | Start the emulator via the bundled launcher and detach, so the CLI can exit while it keeps running. |
| `emulator status [--address <host:port>] [--json]` | Report whether the emulator is installed, running, and connected to `hdc`, without starting it. Exits non-zero when not installed. DevEco Studio's HarmonyOS emulator is not covered; it shows up in `devices`. |
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

#### `doctor` — check the machine can build, check, sign and test

`doctor [project-dir]` (defaults to the project in the current directory, if any). One line per check, `ok`, `warn`, `fail` or `skip`, with the fix under anything that is not ok; exits 1 when a check fails.

| Check | Fails when |
| --- | --- |
| `node`, `java` | Node.js is older than 20; no Java on `JAVA_HOME` or `PATH` (its `-version` is recorded). |
| `sdk` | The SDK the project's `compileSdkVersion` names is not installed (the HarmonyOS SDK for a HarmonyOS project, and its release must match). `--fix` installs it. |
| `cmdtools` | The command-line tools are missing, or a partial install (`bin/ohpm`, `bin/hvigorw`, `bin/codelinter`, `hvigor/`, `ohpm/`, `codelinter/`, `tool/node`, the SDK toolchains or `version.txt` missing). The version is recorded. |
| `cmdtools-flavour` | The tools are the other flavour than the project's `runtimeOS`, so `lint` skips its checks. |
| `arkts-check` | `check arkts` does not run, or runs but misses an error planted in a generated one-file project. |
| `hdc`, `device` | hdc does not run; no device or emulator is reachable; the device's API is below the project's `compatibleSdkVersion`. A device of the other OS family is a warning. |
| `signing` | The signingConfig names material that is missing (no signingConfig at all is a warning). |
| `disk` | Under 1 GB free where SDKs install or the project builds (under 5 GB is a warning). |

| Flag | Description |
| --- | --- |
| `--json` | Print the report: `ok`, `checks` (`id`, `status`, `detail`, `fix`, `fixed`), `project` (`runtimeOS`, `compileSdkVersion`, `compatibleSdkVersion`, `minApi`), `versions` (`node`, `java`, `cmdTools`, `cmdToolsFlavour`, `sdk`, `hdc`, `deviceApi`), for comparing two machines or two runs. |
| `--fix` | Install the project's missing OpenHarmony SDK. |
| `--no-device` | Skip the device check, on a machine that only builds. |
| `--serial <serial>` | The device to check when several are connected. |
| `--no-arkts-check` | Skip the `check arkts` self-test. |

### Project lifecycle

#### `create` — scaffold a new app from a template

All flags are required except where a default is shown (non-interactive). On success the project path is printed to stdout.

| Flag | Description |
| --- | --- |
| `--name <name>` | Project folder name (letters, digits, `._-`, no slashes). |
| `--bundle <bundleName>` | Bundle name in reverse-DNS form, e.g. `com.example.myapp`. |
| `--location <dir>` | Parent directory the new project folder is created in. |
| `--sdk <api>` | Target SDK API level (e.g. `18`, `20`). |
| `--template <id>` | Template id (default `EmptyAbility`; `HarmonyOSApp` targets HarmonyOS). |
| `--module <name>` | Module folder name (defaults to the template default, usually `entry`). |
| `--overwrite` | Replace the destination if it already exists. |

#### `templates` — inspect bundled templates

| Command | Description |
| --- | --- |
| `templates list [--json]` | List the project templates shipped with the CLI. |

#### `auth` — sign in to a Huawei developer account

Only needed for HarmonyOS signing; see [HarmonyOS apps](#harmonyos-apps).

| Command | Description |
| --- | --- |
| `auth login [--timeout <s>] [--port <n>] [--no-browser\|--manual] [--print-url] [--json]` | Sign in via the browser (default timeout 600s). With the browser on another machine: `--manual` and paste the address it ends up on, or `--port` and an `ssh -L` tunnel. See [Signing in from a headless host](#signing-in-from-a-headless-host). |
| `auth logout` | Delete the locally stored token. |
| `auth status [--json]` | Show the signed-in account; exits non-zero when signed out. |
| `auth team list [--json]` | List AGC teams. |

#### `sign` — generate signing keys, certs, and `signingConfigs`

`sign [project-dir]` (defaults to the current directory). Requires `java` on `PATH`. Rewrites the `signingConfigs` block of `build-profile.json5`, and points any product that names no `signingConfig` at the generated one (other keys are preserved). The generated profile uses the SDK's built-in development cert (`issuer=pki_internal`) and its validity window — **dev/local builds only, not distribution.** See [Signing apps that need system permissions](#signing-apps-that-need-system-permissions) for `--apl` / `--acls`.

The last line names what was made: `Signing configs generated (release profile, apl normal; certificate valid until 2049-12-31 12:21 UTC).` With `--harmonyos`, it names the profile's type and expiry, which for AGC's debug profiles is 14 days out: `Signing configs ready for com.example.myapp (profile names 6 device(s), debug, valid until 2026-10-01 11:50 UTC).` `oniro-app app verify <hap>` checks what actually signed a built HAP.

| Flag | Description |
| --- | --- |
| `--apl <level>` | Ability Privilege Level: `normal` (default), `system_basic`, or `system_core`. |
| `--app-feature <feature>` | `hos_normal_app` or `hos_system_app`. Defaults follow `--apl`. |
| `--acls <list>` | Comma-separated permissions to write into the profile's `acls.allowed-acls`. |
| `--app-privilege-capabilities <list>` | Comma-separated privileges to write into the profile's `app-privilege-capabilities`, e.g. `AllowAppUsePrivilegeExtension` for an app with a privileged extension ability (without it, install fails with `9568344 not allow use privilege extension`). |
| `--bootstrap` | No-op if signing material is already present; otherwise generate it. |
| `--harmonyos` | Sign a HarmonyOS project via AppGallery Connect instead of the offline flow. See [HarmonyOS apps](#harmonyos-apps). |
| `--hap <file>` | Sign a prebuilt `.hap` instead of a project and write a signed copy. See [Signing a prebuilt HAP for OpenHarmony](#signing-a-prebuilt-hap-for-openharmony), and with `--harmonyos`, [for HarmonyOS](#signing-a-prebuilt-hap). |
| `--out <file>` | With `--hap`: where to write the signed HAP (default: next to the input, named `<name>-signed.hap`, or `<name>-resigned.hap` for a `*-signed.hap` input). |
| `--team-id <id>` | With `--harmonyos`: AGC team to sign under. |
| `--product <name>` | With `--harmonyos`: product to sign (default `default`). |
| `--force` | With `--harmonyos`: regenerate even when the existing material is still valid. |
| `--store-password <pwd>` / `--key-password <pwd>` | Keystore passwords (default `123456`, the SDK keystore password). |

#### Signing a prebuilt HAP for OpenHarmony

`sign --hap <file>` signs a HAP you have no project for: an unsigned build output, or a HAP signed
with other material (its signature is replaced). It uses the same SDK development certificate as a
project, with a profile for the bundle name in the HAP's `module.json`. `--apl`, `--app-feature`,
`--acls`, `--app-privilege-capabilities` and the password flags apply as for a project; the ACLs are
not read from the HAP, so pass `--acls` for a permission above the app's apl.

```sh
oniro-app sign --hap entry-default-unsigned.hap                  # writes entry-default-signed.hap
oniro-app sign --hap SystemUI.hap --out SystemUI.hap --apl system_basic --acls ohos.permission.REBOOT
oniro-app app install entry-default-signed.hap
```

The signed copy goes next to the input by default (`<name>-unsigned.hap` → `<name>-signed.hap`,
`<name>.hap` → `<name>-signed.hap`, `<name>-signed.hap` → `<name>-resigned.hap`); only an `--out`
naming the input re-signs it in place. `--team-id` and `--force` are refused here. Signing is
offline and needs only `java` and an installed OpenHarmony SDK: the one the HAP's `targetAPIVersion`
names, else the newest (every release ships the same signing material). Nothing is written to a
project, and the material is made in a temporary directory that is removed afterwards. A HAP built
for HarmonyOS is refused with a pointer to `--harmonyos`.

#### `build` — build the app via `hvigorw`

`build [project-dir]` (defaults to the current directory). Modules build in parallel by default. An OpenHarmony project whose `compileSdkVersion` SDK is not installed fails before anything runs, naming the release to install. A failed build lists its errors on stderr, one per line (`file:line:col error source code: message (rule)`), after hvigor's own output. When the project uses kit symbols that its SDK lacks but a newer installed SDK declares, the error names that API level; when no installed SDK has them (`'…' is not exported from Kit '…'`), it adds a hint about the full SDK, which carries the system APIs. A failed build names the SDK it compiled against (`Built against HarmonyOS 5.1.0 (API 18) at ~/command-line-tools/sdk.`). When the errors are missing properties or names (`Property '…' does not exist on type …`, `Cannot find name '…'`) in code under `oh_modules/`, it adds a hint naming the dependency and that SDK: the dependency may need a newer API level than the SDK has. The hint reads only the compiler messages, not the dependencies' metadata, whose declared `compatibleSdkVersion` can be wrong.

A build that signs with material for the other runtime still passes, but warns on stderr (and with a `signing` warning diagnostic in `--json`). hvigor's SignHap signs with whatever the product's signingConfig holds, and the `-signed.hap` fails only at install time. The two cases are: a product with `runtimeOS: "HarmonyOS"` whose signingConfig lacks `type: "HarmonyOS"` (the OpenHarmony material a plain `sign` writes; run `oniro-app sign --harmonyos`), and an OpenHarmony product whose signingConfig has it (run `oniro-app sign`).

With `--json`, stdout gets one object whether the build passes or fails, and a failed build still exits 1:

```json
{
  "ok": false, "exitCode": 255, "durationMs": 7221,
  "failedTask": ":entry:default@CompileArkTS",
  "diagnostics": [
    { "severity": "error", "source": "arkts", "code": "10605008", "rule": "arkts-no-any-unknown",
      "message": "Use explicit types instead of \"any\", \"unknown\"",
      "file": "entry/src/main/ets/pages/Index.ets", "line": 5, "column": 24,
      "task": ":entry:default@CompileArkTS" }
  ],
  "summary": { "errors": 1, "warnings": 0, "reportedErrors": 2, "reportedWarnings": 1 },
  "discoveredHaps": {}, "warnings": [],
  "error": "hvigorw exited with code 255\nBuilt against OpenHarmony 6.0 (API 20) at /home/user/setup-ohos-sdk/linux/20.",
  "sdk": { "runtimeOS": "OpenHarmony", "displayName": "OpenHarmony 6.0", "version": "6.0.0.47", "api": "20",
           "path": "/home/user/setup-ohos-sdk/linux/20" },
  "rawTail": "last 200 lines of build output, colour codes removed"
}
```

- `source` is `arkts` (the ArkTS compiler), `hvigor` (configuration and task errors such as `00303060`), `native` (clang and lld, one diagnostic per undefined symbol), `ohpm` (the dependency install before the build; `failedTask` is then `ohpm install --all`), `signing` (a signingConfig for the other runtime, see above; `file` is `build-profile.json5`) or `sdk`. An `sdk` diagnostic carries `api`, the API level the build needs: the SDK the project compiles against is not installed (the object also has `missingSdk: { api, version, expectedPath }`), or a newer installed SDK declares the symbols the build could not find. A `warning` `sdk` diagnostic without `api` is the dependency hint above.
- `sdk` is the SDK the build compiled against: `runtimeOS`, `displayName`, `version` (`6.1.1(24)` for HarmonyOS, the SDK build for OpenHarmony), `api` and `path` (`DEVECO_SDK_HOME` for HarmonyOS). It is there for a build that passed too, and absent when it cannot be told (an ohpm failure, a missing SDK, no numeric `compileSdkVersion`).
- `file` is relative to the project when it lies inside it. hvigor prints the ArkTS block twice; each diagnostic is listed once.
- `summary.reportedErrors` and `reportedWarnings` are hvigor's own `COMPILE RESULT` counts. They can exceed the distinct diagnostics (hvigor counts 3 errors for the two above), so use them as a cross-check, not as the length of the list.
- A build that passes has `ok: true`, `discoveredHaps` (HAPs grouped by module) and its compiler warnings in `diagnostics`.
- When the build cannot run at all (no command-line tools, not a project), the object is `{ ok: false, exitCode: 1, error, diagnostics: [] }`.

| Flag | Description |
| --- | --- |
| `--product <product>` | hvigor product name (default `default`). |
| `--module <module>` | Restrict the build to a single module. |
| `--mode <mode>` | hvigor build mode (e.g. `release`, `debug`). |
| `--task <task>` | hvigor task to run (default `assembleHap`). |
| `--no-deps` | Skip the automatic `ohpm install --all` when `oh_modules/` is missing. |
| `--no-parallel` | Build modules serially. |
| `--install-sdk` | Install the missing OpenHarmony SDK the project compiles against, then build. |
| `--json` | Print the result as one JSON object, described above, whether the build passes or fails. |

#### `test` — run the module's ohosTest suite on the device

`test [project-dir]` (defaults to the current directory) builds the module's main HAP and its test HAP (`hvigorw … -p module=entry@ohosTest`), installs the main HAP the way `app apply` does and the test HAP after it, runs the suite with `aa test -b <bundle> -m <test module> -s unittest OpenHarmonyTestRunner`, and prints one line per case:

```text
FAIL ActsAbilityTest > listHasItems (2 ms)
    expect 0 equals 3
    at entry/src/ohosTest/ets/test/Ability.test.ets:26:17
PASS IndexTest > tapShowsWelcome (656 ms)
4 run: 3 passed, 1 failed, 0 errors, 0 ignored.
```

Exits **0** when every case passed, **1** when a case failed (an assertion, runner code -2) or threw (-1), and **2** when the run itself did not complete: the build failed (its diagnostics are listed, as for `build`), a HAP is missing, the install failed, the runner did not find the test module, no case ran, the run timed out, or there is no device. The test module (`entry_test` in the templates, read from `src/ohosTest/module.json5`) stays installed. Before the run the screen is turned on, a lock screen without a credential is swiped away, and the screen is kept on until the run ends; a lock screen that asks for a credential is reported as a warning, since UI tests cannot get past it.

| Flag | Description |
| --- | --- |
| `--module <module>` | Module whose `src/ohosTest` suite runs (default `entry`). |
| `--product <product>` | hvigor product (default `default`). |
| `--class <filter>` | Run only `Suite`, `Suite#case`, or several of them joined by commas. |
| `--timeout <ms>` | Per-case timeout passed to the runner (default 15000). |
| `--run-timeout <ms>` | Wall-clock limit for the whole run (default 600000); `aa test` can hang when the app dies. |
| `--no-build` | Use the HAPs already built (`<module>/build/<product>/outputs/{default,ohosTest}`). |
| `--no-wake` | Leave the screen as it is. |
| `--mode <mode>` / `--no-deps` | As for `build`. |
| `--device <serial>` | Target device serial. |
| `--json` | Print the report: `ok`, `outcome` (`passed`, `failed`, `runner-error`), `tests` (`suite`, `name`, `status`, the runner's raw `statusCode`, `durationMs`, `message`, `stack`), `summary` (`run`, `pass`, `fail`, `error`, `ignore`), `resultCode`, `resultMessage`, `reportCode`, `bundle`, `testModule`, `haps`, `log` (the app's hilog lines during the run), `warnings`, `error`, `diagnostics` and `failedTask` (for a failed build), `rawTail`. |

`build` and `app install`/`app apply` leave test HAPs (`*-ohosTest-*.hap`) out of the HAPs they pick for a module.

#### `check arkts` — ArkTS type check and lint without a build

`check arkts [project-dir]` (defaults to the current directory) runs the SDK's own ArkTS checker (ets-loader's `etsStandaloneChecker`: the type check and ArkTS linter that the build's `CompileArkTS` task runs) without hvigor, plus the rules hvigor enforces later in a build that the checker does not see: `@Component`/`@ComponentV2` member decorators, `@ObservedV2` types under V1 state, the `@Entry` root node, statements in `build()`, struct names that collide with built-in components, `Navigation` route builders and route maps, `$r('app.*')` and `$r('sys.*')` resource names, resource directory names, `main_pages.json` pages, and `module.json5` permissions. It checks against the SDK the project compiles with: `<sdk home>/<compileSdkVersion>` for OpenHarmony, the located HarmonyOS SDK (with its `hms/ets` APIs) for a `runtimeOS: "HarmonyOS"` project. It needs no build, no device and no codelinter, so it works whichever flavour the command-line tools are.

Prints each diagnostic as `file:line:col severity arkts-check: message (rule)`, then the totals. Exits 0 when clean, 1 on an error, 2 when the checker could not run (the SDK is missing, or the checker crashed): then nothing is known about the code, so do not read it as a pass. `lint --engine arkts` runs the same check.

| Flag | Description |
| --- | --- |
| `--files <files...>` | Check only these `.ets` files. The project-wide rules (`main_pages.json`, route maps, resource directories, `module.json5`) are then skipped. |
| `--fix` | Apply the fixes the checker can verify: the compiler's `Did you mean` suggestions, an import path ending in `.ets` or with the wrong depth, a default import of a module with only named exports, a missing `export` (in the declaring file, listed in `alsoModified`), misplaced imports, a `@Component`/`@ComponentV2` decorator that contradicts every member. It re-checks, reverts any file whose error count rose, and lists what it fixed in `fixed`. |
| `--sdk <dir>` | Check against this SDK directory (the one holding `ets/`) instead of the one `compileSdkVersion` names. |
| `--json` | Print the report: `ok`, `completed`, `diagnostics` (`severity`, `source: "arkts-check"`, `rule`, `message`, `file`, `line`, `column`, the shape `build --json` uses), `fixed`, `alsoModified`, `summary` (`errors`, `warnings`, `fixed`, `files`, `checkerDiagnostics`), `sdk`, `durationMs`, `error`. |

The checker is deveco-cli's `arkts-check.cjs` (MIT, see `NOTICE`), run in a child `node` process.

#### `screens` — static page and route inventory

`screens [project-dir]` (defaults to the current directory) lists the pages of a project, the routes between them and the placeholder content left in them, read from the sources of every module in `build-profile.json5`. It needs no build, no SDK and no device.

- **Pages.** `@Entry` pages listed in `main_pages.json` (named `pages/Index`), `@Entry({ routeName })` named routes, `NavDestination` pages registered in a route map (`module.json5` `"routerMap": "$profile:route_map"`, named by the map's `name`) or in a `.navDestination(builder)` builder that dispatches on the route name (`if (name === 'Detail') { DetailPage() }`, with `==`, `||` and string constants such as `RouteNames.DETAIL`). An `@Entry` struct that `main_pages.json` does not list, and a struct whose `build()` root is `NavDestination` but that nothing registers, are listed as unregistered.
- **Content nodes.** The component calls a page renders, following its custom components and `@Builder`s (in the same file or elsewhere in the project), counting each `if` branch and each `ForEach`/`LazyForEach`/`Repeat` item template once, and leaving out layout containers (`Column`, `Row`, `Stack`, `Flex`, `RelativeContainer`, `List`/`ListItem`, `Grid`/`GridItem`, `Scroll`, `Tabs`/`TabContent`, `Swiper`, `Navigation`, `NavDestination`, ...) and `Blank`/`Divider`. Builders passed as attributes (`.navDestination(...)`, `.bindSheet(...)`) are not part of the page.
- **Routes.** Call sites of `pushUrl`, `replaceUrl`, `pushNamedRoute`, `replaceNamedRoute` (`router` or `getUIContext().getRouter()`), `pushPath`, `pushPathByName`, `replacePath`, `replacePathByName`, `pushDestination`, `pushDestinationByName` (`NavPathStack`), and the ability's `loadContent`. The target is read from a literal, a constant, a `{ url }`/`{ name }` object or `new NavPathInfo(...)`, also through a local `const options: RouterOptions = { url: ... }`; any other target is reported with its source text and marked dynamic. `from` is the page whose component holds the call site, else the enclosing struct, class or function; a page's routes out include those of the components it renders.
- **Placeholders.** `TODO`/`FIXME` comments, string literals and `string.json` values that read like placeholders (`placeholder`, `lorem ipsum`, `coming soon`, `TBD`, `not implemented`, `under construction`, `Hello World`), an empty `build()`, and a page that renders no content node.

Prints three tables (pages, routes, placeholders) and any warnings (a page `main_pages.json` lists whose file is missing, a route-map entry whose file or builder is not found, a builder whose route names cannot be read). Exits 0, since it is an inventory, not a gate, and 1 when the project cannot be read. The G2 gate ("every spec screen has a page with at least k content nodes and every spec route has a push call site") is `checkScreensAgainstSpec` in `@oniroproject/core`, a pure function of the `--json` output.

| Flag | Description |
| --- | --- |
| `--json` | Print the inventory: `pages` (`name`, `module`, `file`, `line`, `component`, `entry`, `kind` (`entry` or `navDestination`), `registered`, `contentNodes`, `routesOut`), `routes` (`from`, `to`, `file`, `line`, `via`, `dynamic`), `placeholders` (`file`, `line`, `text`, `kind`: `comment`, `text`, `resource`, `empty-build`, `no-content`), `warnings`, `modules`, `projectDir`; `{ "error": ... }` when the project cannot be read. |

#### `api search` / `api show` — look up the SDK's declarations

What the SDK at one API level declares, read from its own typings: the ArkTS API (`ets/api`, `ets/arkts`), the global ArkUI components and decorators (`ets/component`), with the kit that re-exports each symbol (`ets/kits/@kit.*.d.ts`), and the Node-API C headers (`native/sysroot/usr/include/{node_api*,js_native_api*}.h`, `napi/*.h`). Use it to check that an API exists, at the API level the project compiles with, before writing code against it.

- `api search <query...>` ranks symbols: every word must match a name (exact name, then prefix, then a camelCase or snake_case part such as `Path` in `pushPathByName`, then a substring), the class or namespace it belongs to, or its doc line. A dotted word matches qualified names (`router.pushUrl`); a leading `@` is ignored (`@Local`). Overloads are one hit. Exits 1 when nothing matches.
- `api show <symbol>` is an exact lookup by qualified name (`NavPathStack.pushPathByName`, `router.pushUrl`, `Column`, `@Local`, `napi_create_threadsafe_function`), else by dotted suffix (`Preferences.get`). It prints every declaration and exits 0 when the SDK declares it; otherwise it exits 1 and names the other installed SDKs that declare it (with their `@since`) and the closest names this SDK does declare.
- `api index` builds or refreshes the index and prints its size (for warming a cache in CI).

Each hit prints the qualified name, kind (`namespace`, `class`, `interface`, `enum`, `enumMember`, `type`, `function`, `method`, `constructor`, `property`, `variable`, `component`, `decorator`, and for C `macro`, `typedef`, `struct`), kit, `since` (the lowest `@since` of its doc comments, counted from when it became public for a former system API), `@deprecated` with `@useinstead`, `@systemapi`, the declaration text, the first doc line, `file:line`, the module, and how to import it (`import { router } from '@kit.ArkUI'`, or `global, no import` for the ArkUI component declarations).

```
$ oniro-app api show NavPathStack.getPathStack --api 18
NavPathStack.getPathStack is not declared in API 18 (5.1.0.107).
  declared in the installed API 23 SDK (@since 19)
```

The SDK is `--sdk <dir>`, else `<sdk home>/<--api>`, else the one the project's `compileSdkVersion` names (the project in the current directory or `--project`, looked up the way hvigor does), else the newest installed. The index is built on the first use of an SDK (about 3 s for API 23, parsing with the SDK's own TypeScript) and cached under `~/.oniro/cache/api-index/` (`ONIRO_CACHE_DIR`), keyed by the SDK directory and its `oh-uni-package.json` mtimes, so a reinstalled SDK is re-indexed.

| Flag | Description |
| --- | --- |
| `--api <level>` | The SDK API level to read. |
| `--sdk <dir>` | An SDK API directory (holding `ets/`) to read instead. |
| `--project <dir>` | The project whose `compileSdkVersion` picks the SDK (default: the current directory). |
| `--rebuild` | Rebuild the index even when the cached one is current. |
| `--kit <name>` | Only symbols this kit exports (`ArkUI` or `@kit.ArkUI`). |
| `--kind <kinds...>` | `search` only: only these kinds. |
| `--lang <arkts\|c>` | `search` only: only ArkTS declarations, or only the Node-API headers. |
| `--limit <n>` | `search` only: at most n hits (default 20). |
| `--no-deprecated` / `--no-systemapi` | `search` only: leave out `@deprecated` / `@systemapi` symbols. |
| `--no-other-sdks` | `show` only: on a miss, do not look in the other installed SDKs. |
| `--json` | `search`: `sdk` (`dir`, `api`, `version`, `source`), `query`, `total`, `hits` (the fields above as `name`, `qualifiedName`, `kind`, `kit`, `import`, `global`, `module`, `since`, `sinceText`, `deprecated`, `deprecatedSince`, `useInstead`, `syscap`, `systemApi`, `file`, `path`, `line`, `signature`, `doc`, `overloads`, `score`). `show`: `sdk`, `symbol`, `found`, `entries`, and on a miss `alsoIn` (`[{ api, since }]`) and `suggestions`. |

#### `lint` — run the OpenHarmony codelinter

`lint [project-dir]` (defaults to the current directory). Prints each finding as `file:line:col severity message [rule]`, then the totals (`N defects: E errors, W warnings, S suggestions.`). Exits 1 on error-severity findings or when codelinter fails to produce a report; warnings alone exit 0, although codelinter itself exits 1 for them. When codelinter says its report is incomplete, for example because the command-line tools' flavour (see `cmdtools status`) does not match the project's `runtimeOS`, it exits 2: it skipped checks, so a clean report is not evidence of clean code. Its notices, and a hint when the flavour is the cause, go to stderr.

| Flag | Description |
| --- | --- |
| `--files <globs...>` | Specific files/globs to lint (default: the whole project). |
| `--json` | Emit the report as JSON: `findings`, `summary` (codelinter's totals), `notices`, `incomplete`, `code`, and the cleaned `raw` output. |
| `--allow-incomplete` | Exit 0 rather than 2 for an incomplete report without errors. |
| `--engine <engine>` | `codelinter` (default), or `arkts` to run `check arkts` instead, with its report and exit codes. |

### Device & app

These commands target a connected device or emulator over `hdc`. Most accept `--device <serial>` to address a specific target. Without it they use `ONIRO_DEVICE_SERIAL`, then the single connected device. A TCP serial such as `127.0.0.1:5555` works like a USB one. hdc exits 0 even when it fails (`[Fail]ExecuteCommand need connect-key?` when several targets are connected and none was named); every command here reports that as an error.

#### `devices` — list connected hdc devices

| Command | Description |
| --- | --- |
| `devices [--long] [--json]` | List connected targets (`serial`, connection, status). `--long` also asks each connected one for its OS family and version (`os=HarmonyOS 6.1.0` / `os=OpenHarmony`), API level, CPU ABI, device type, model, and `const.ohos.fullname`. |

#### `app` — install, launch, and manage built apps

| Command | Description |
| --- | --- |
| `app install [project-dir \| file.hap] [--hap <path>] [--device <serial>]` | Install a `.hap` via `hdc`: a given file, else the project's newest signed HAP, else its unsigned one (a `*-signed.hap` path that does not exist falls back to its `*-unsigned.hap`). Fails when the bundle manager rejects the HAP; when a target refuses an unsigned HAP, the error gives the bundle manager's reason and the `sign` command to run. |
| `app launch [project-dir] [--module <m>] [--ability <name>] [--device <serial>] [--smoke]` | Launch the app. `--ability` defaults to the module's `mainElement` / first visible ability. `--bundle <b>` launches an installed app without a project. With `--smoke`, also judge the launch (below). |
| `app apply [project-dir] --bundle <b> [options]` | Install a HAP **and verify it took**: fails when the bundle manager rejects it or `bm dump` does not then list the bundle, and handles sign-info mismatch, asset-cache invalidation, and persistent-bundle restart. Uses the newest signed HAP, else the unsigned one, and explains a target's refusal of an unsigned HAP like `app install`. |
| `app uninstall <bundle> [--device <serial>]` | Uninstall an app by bundle name. |
| `app stop <bundle> [--device <serial>]` | Force-stop an app by bundle name. |
| `app verify <hap> [--json]` | Verify a HAP's signature and report what signed it, profile expiry included. See [Verifying a HAP's signature](#verifying-a-haps-signature). |

`app apply` options:

| Flag | Description |
| --- | --- |
| `--bundle <bundle>` | **Required.** Bundle to apply changes to. |
| `--module <module>` | Module to resolve the HAP from (multi-module projects). |
| `--hap <path>` | Explicit `.hap` path (else resolved from the project + module). |
| `--installed-hap <path>` | Local copy of the currently-installed HAP, to enable the asset-cache reboot diff. |
| `--system` | Treat as a persistent/system bundle (refuses to uninstall on a sign-info mismatch). |
| `--allow-uninstall` | Permit uninstalling a system bundle on sign-info mismatch (dangerous). |
| `--device <serial>` | Target device serial. |
| `--json` | Emit the result (`method`, pre/post-install pid, `cacheCleared`) as JSON; with `--smoke`, plus a `smoke` object. |
| `--smoke` | After installing, launch the app and judge the launch (below). |

**Launch smoke check** (`app launch --smoke`, `app apply --smoke`): wakes the screen and swipes away a lock screen without a credential, launches, waits for the app's process (up to 10 s), waits `--smoke-delay`, takes a screenshot, and checks the process is still the same pid. The verdict fails, and the command exits 1, when the process never started or died, a crash was recorded since the launch (read with `logs crash`'s faultlog reader, which waits up to 15 s for the faultlog of an app that died), or the screen is blank: the app area (status and navigation bars cropped off) is a flat frame by perceptual hash with little variance, or 99.8 % one colour — the deveco-cli smoke-inspector pattern. `--json` prints it (`app launch` as `{ bundle, smoke }`):

```json
{ "smoke": { "passed": false, "failures": ["the screen is blank"], "pid": 15446, "alive": true,
  "blankScreen": true, "blankScore": 1, "blank": { "phashDistance": 0, "stdDev": 0, "background": 255, … },
  "screenshot": "/tmp/oniro-smoke-com.example.app-1762342512000.jpeg", "crash": null, "crashChecked": true, "delayMs": 2000 } }
```

`blankScore` is the share (0–1) of the app area in its dominant colour: a "Hello World" page scores about 0.977, an empty page 1. `crash` is the `logs crash --json` verdict of the newest fault since the launch (`js_crash`, `cpp_crash`, `app_freeze`, with its reason and project frame), or `null`; the text line names it, e.g. `js_crash (RangeError) at entry/src/main/ets/pages/Index.ets:8`.

| Flag | Description |
| --- | --- |
| `--smoke-delay <ms>` | Wait between the process appearing and the screenshot (default `2000`). |
| `--smoke-screenshot <file>` | Where to write the screenshot (default: `oniro-smoke-<bundle>-<time>.jpeg` in the system temp dir). |

#### Verifying a HAP's signature

`app verify <hap>` runs the SDK's `hap-sign-tool.jar verify-app` on the HAP (from an installed
OpenHarmony SDK, else the HarmonyOS SDK, else the command-line tools; it needs `java`), then reads
the certificate chain and provisioning profile the HAP carries. No device is needed.

```console
$ oniro-app app verify entry/build/default/outputs/default/entry-default-signed.hap
…/entry-default-signed.hap: valid
  signature:    valid
  signer:       HarmonyOS, issued by AppGallery Connect (chains to Huawei CBG Root CA G2)
  chain:        Jane Dev(1234),Development  [leaf, until 2026-10-01 11:50 UTC]
                Huawei CBG Developer Relations CA G2 DRE  [intermediate, until 2030-08-16 16:23 UTC]
                Huawei CBG Root CA G2  [root, until 2049-03-16 03:04 UTC]
  profile:      debug, issuer app_gallery
  bundle:       com.example.myapp
  apl:          normal
  app-feature:  hos_normal_app
  devices:      6
  validity:     2026-09-17 12:00 UTC to 2026-10-01 11:50 UTC, 6 days left
  note:         a debug profile installs only on the devices it names
```

It reports whether the signature is valid; the chain, leaf first, and its root; whether the
material is OpenHarmony development material (the SDK's certificate, profile issuer `pki_internal`),
which only OpenHarmony devices accept, or a HarmonyOS certificate from AppGallery Connect; and the
profile's type, bundle name, apl, app-feature, device count and validity. A HAP is **invalid** when
it is unsigned, hap-sign-tool rejects its signature, a certificate or (for AGC material) the
profile has expired, the profile names another certificate or bundle than the HAP's, or a HAP
built for HarmonyOS carries OpenHarmony development material. The SDK's development profile
carries a fixed validity window that ended in 2023, which OpenHarmony devices do not enforce, so
that is only a note. `--json` emits every field (dates as ISO strings).

Exit codes: `0` valid, `1` invalid, `2` could not verify (no HAP, no `java`, no `hap-sign-tool.jar`).

#### `file` — transfer files to/from the device

| Command | Description |
| --- | --- |
| `file send <local> <remote> [--bundle <b>] [--device <serial>]` | Push a local file to the device and print the device path. With `--bundle`, `<remote>` may be relative to that app's sandbox (`files/x` is its application-level `filesDir`, `haps/entry/files/x` the entry module's), and the file is chowned to the app, which cannot read root-owned files. |
| `file recv <remote> <local> [--device <serial>]` | Pull a file from the device. |

Local paths may be relative, or absolute with either slash. A device path that a Windows shell already rewrote (Git Bash turns `/data/local/tmp/x` into `C:/Program Files/Git/data/local/tmp/x`) is rejected: run the command with `MSYS_NO_PATHCONV=1`.

#### `logs` — capture hilog to a file for a whole session

`logs -o <file>` streams hilog into `<file>` until `--for` elapses or the process is interrupted, so start it in the background. The device's log buffer is small (256 KB per type by default) and chatty components such as ArkWeb wrap it within seconds, so a dump at the end of a session loses its start. Every line is written as it arrives, and the stream reconnects after a reboot.

| Flag | Description |
| --- | --- |
| `-o, --output <file>` | **Required.** File to append to. |
| `--for <ms>` | Stop after this long (default: until interrupted). |
| `--grep <regex>` | Keep only matching lines (default: all). |
| `--clear` | Clear the device log buffer first (`hilog -r`), so the file covers only this session. |
| `--domain <domain>` | hilog domain filter (e.g. `0xD003900`). |
| `--device <serial>` | Target device serial. |

#### `logs collect` — create a diagnostic bundle

```bash
oniro-app logs collect --redact --package com.example.app
```

The command requires exactly one connected device unless `--device` (or
`ONIRO_DEVICE_SERIAL`) selects one. It captures the current `hilog -x` buffer,
faultlog evidence, device information, process list, and memory/thread snapshots.
Because `hilog -x` has no duration argument, `--duration` filters recognized
HiLog timestamps locally using device clock readings before and after the snapshot.
If the clock or log format cannot be parsed reliably, the manifest records the
window as unapplied, the command exits non-zero, and the full snapshot is omitted
from the redacted archive (it remains only in the local raw bundle).
`--pid`, `--tag`, and `--level` create an additional filtered HiLog view from the
time-bounded records when their format can be parsed reliably. `--package`
targets `hidumper -e --print <bundle> -n 5` for faultlog evidence.

`--redact` creates a sibling `incident-...-redacted` directory and ZIP; the
archive is built only from that redacted copy. Without `--redact`, the archive
contains raw sensitive data. Redaction is heuristic, fails closed on binary or
unknown-encoding files, and does not guarantee that a bundle is safe to publish.
Collection continues after individual command failures and records each result
in `manifest.json`; the CLI exits non-zero for a partial bundle. The default
output is under `~/.oniro/incident-bundles`; bundle files are created with
owner-only permissions where the host OS supports POSIX modes.

| Flag | Description |
| --- | --- |
| `-o, --output <directory>` | Parent directory for bundles (default `~/.oniro/incident-bundles`). |
| `--device <serial>` | Target device serial. |
| `--package <bundle>` | Bundle name for package-specific faultlog collection. |
| `--pid <pid>` | Create an exact-PID filtered HiLog view. |
| `--tag <tag>` | Create an exact-tag filtered HiLog view. |
| `--level <level>` | Create a filtered view for `V`, `D`, `I`, `W`, `E`, or `F`. |
| `--duration <seconds>` | Include HiLog records from the last N seconds (default `600`; maximum `31536000`). |
| `--redact` | Redact text evidence; create the archive only from the redacted copy. |
| `--json` | Emit bundle paths and completion status as JSON. |

#### `logs crash` — what the last crash was, and where

```bash
oniro-app app launch && oniro-app logs crash --since 30 --wait 15000 --json
```

Fetches the newest faultlog of an app and classifies it: `cpp_crash` (a native signal), `js_crash` (an uncaught
ArkTS/JS error), `app_freeze` (`THREAD_BLOCK_6S`, `APP_INPUT_BLOCK`, `LIFECYCLE_TIMEOUT`, or a service's
`SERVICE_BLOCK`), `sample_stack` or `unknown`, each with a `confidence`. The bundle defaults to the project in the
current directory, else the newest fault of any process. Faultlogs are listed with
`hidumper -s 1201 -a '-p Faultlogger -LogSuffixWithMs'` and read with `-f <name>`. Some builds never turn an app's
native crash into a faultlog (hiview logs `Fail to add fault log … is not processdump`); the command then reads
faultloggerd's record in `/data/log/faultlog/temp/cppcrash-<pid>-<ms>.json` instead and says so in `notes`. The
whole log is saved under `--output`.

The verdict (`--json`) has `crashed`, `kind`, `subtype` (the freeze event), `confidence`, `bundle`, `pid`, `tid`,
`time` (device local), `reason`, `topFrame`, `projectFrame` (the first frame in the project's own code), `file`, `line`
and `column` of the first project ArkTS frame (for a native crash, the ArkTS code that called into it),
`jsError {name, message, stack}`, `stack` (the faulting thread's frames as printed), `nativeFrames` (`index`, `pc`,
`library`, `symbol`, `buildId`, `area`), `jsFrames`, `binderChain` and `deadlocks` (freeze), `notes`, `name`, `path`
(on the device) and `rawPath` (the saved copy). Without a fault it prints `{ "crashed": false, "kind": null, … }`.
The command exits 0 either way: a gate reads `crashed`.

| Flag | Description |
| --- | --- |
| `--bundle <bundle>` | App to look for (default: the current project's `bundleName`, else any process). |
| `--since <s\|ISO>` | Only faults from the last N seconds by the device clock, or since an ISO 8601 time. |
| `--wait <ms>` | Keep looking this long when there is no fault yet (hiview writes it a few seconds after the process dies). |
| `--path <file>` | Analyse a local faultlog or `.json` crash record instead of fetching one. |
| `-o, --output <directory>` | Where to save the fetched log (default `~/.oniro/faultlogs`). |
| `--device <serial>` | Target device serial. |
| `--json` | Print the verdict as JSON. |

#### `hdc` — run the bundled hdc

`hdc [args...]` runs the `hdc` binary oniro-app itself uses (the one `cmdtools status` shows), with stdio passed through, so it needs nothing on `PATH`. Device commands are addressed at `--device` or `ONIRO_DEVICE_SERIAL` unless the arguments start with `-t`. `hdc --path` prints the binary's location. The exit code is hdc's own, which is 0 even for a `[Fail]` line.

```bash
oniro-app hdc shell param get const.ohos.apiversion
oniro-app hdc --device 127.0.0.1:5555 shell aa dump -l
```

#### `reboot` — reboot the device

| Flag | Description |
| --- | --- |
| `--mode <mode>` | `system` (default), `bootloader`, or `recovery`. |
| `--wait-bundle <bundle>` | After a system reboot, wait until this bundle is running again. |
| `--timeout <ms>` | Max time to wait for the bundle (default `180000`). |
| `--device <serial>` | Target device serial. For a TCP target (an emulator at `host:port`), passing this reconnects the session across the reboot, restarting the hdc server if it keeps the dead session. |

#### `wait` — wait for a device condition

Specify exactly one of `--log`, `--boot`, `--bundle`, or an element selector (`--target` / `--target-id` / `--target-type`, or `--selector`).

| Flag | Description |
| --- | --- |
| `--log <pattern>` | Resolve when a hilog line (`tag: message`) matches this regex. |
| `--boot` | Resolve when the device is reachable. |
| `--bundle <bundle>` | With `--log`: filter to this bundle. Alone: wait until this bundle is running. |
| `--pid-of <name>` | With `--boot`: also require this process to have a pid. |
| `--domain <domain>` | With `--log`: hilog domain filter (e.g. `0xD003900`). |
| `--target <text>` | Resolve when an uncovered element whose text, description, or placeholder matches is on screen (case-insensitive; exact matches win, else substring). |
| `--target-id <id>` / `--target-type <type>` | Match the element by id/key, or restrict it to a component type (e.g. `Button`). |
| `--selector <expr>` | Instead of `--target*`: an attribute selector or `xpath=` expression (see [Selectors and windows](#selectors-and-windows)). With a `[n]` suffix, waits for that match. |
| `--window <id>` | With a selector: only look in this window; while it is not on screen nothing matches. |
| `--gone` | With a selector: resolve when no uncovered element matches any more. |
| `--interval <ms>` | With a selector: poll interval (default `500`; each poll is a layout dump). |
| `--timeout <ms>` | Max wait (default `30000`). |
| `--device <serial>` | Target device serial. |
| `--json` | With `--log` or a selector: emit the matched entry or element as JSON. |

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

Default: writes the full-resolution raw JPEG. `--grid` reproduces the old MCP screenshot (downscaled + grid overlay). `--crop` / `--target` / `--selector` / `--window` write a full-resolution crop of one region, element or window — detail where it is needed without the cost of a full-resolution screenshot. `--contact-sheet` captures a burst (default 8 frames) into one tiled sheet and prints per-frame diffs (0..1) on stdout — one image instead of N, pointing you at the frame where something changed. `--diff <baseline.jpeg>` captures the screen (to `--output`) and compares it with a baseline.

| Flag | Description |
| --- | --- |
| `-o, --output <file>` | Output path (default `screenshot.jpeg`). |
| `--grid` | Downscale to `--max-dim` and overlay a 10x10 grid (axes 0.0–1.0) for picking tap coordinates. |
| `--max-dim <px>` | Longest-side cap for `--grid` / `--crop` / `--target` / `--contact-sheet` (256–4096, default `1024`). On its own, downscales without a grid. |
| `--crop <x1,y1,x2,y2>` | Crop to this region, given as 0–1 fractions of the screen (as in `dump layout` and the grid). |
| `--target <text>` | Crop to the element whose text, description, or placeholder matches, plus a small margin. Also `--target-id`, `--target-type`, `--target-index`. |
| `--selector <expr>` | Crop to the element this selector picks, like `--target` (see [Selectors and windows](#selectors-and-windows)). |
| `--window <id>` | Crop to this window; with `--target*` / `--selector`, only look for the element in it. |
| `--contact-sheet` | Capture a burst and composite it into one tiled image with per-frame change diffs. |
| `--burst <count>` | Capture N frames; writes `<base>-<i><ext>` (or sets the `--contact-sheet` frame count). |
| `--interval <ms>` | Delay between burst frames (default `50`). |
| `--diff <baseline.jpeg>` | Capture and compare with this screenshot: pHash and dHash distance (0–64 bits), `pixelChangeRatio` (share of pixels that moved more than 24 of 255 grey levels), `meanDiff` (the contact sheet's change metric), and `same` (both hashes within 4 bits, under 1 % of pixels changed). Images of different sizes are scaled to a common one (`sizeMismatch` flags a different aspect). Exits 0 either way. |
| `--json` | With `--contact-sheet` or `--diff`, emit the full result object as JSON on stdout. |
| `--device <serial>` | Target device serial. |

```text
$ oniro-app screenshot --diff before.jpeg -o after.jpeg
different: pHash 9/64, dHash 5/64, 2.47% of pixels changed, mean change 0.0072
```

#### `dump` — dump device state

| Command | Description |
| --- | --- |
| `dump [layout]` | Dump the on-screen UI layout (the default target) to stdout: a pruned, 0–1-normalized JSON tree, or one line per element with `--flat`. |
| `dump windows` | List every window from `hidumper -s WindowManagerService`: id (what `--window` takes), name, pid, type (1 = an app's main window), z-order (-1 = not shown), rectangle, and which one has focus. `--json` for JSON. |

| Flag | Description |
| --- | --- |
| `--bundle <bundle>` | Filter the layout to a single window/bundle. |
| `--flat` | One line per labelled or interactive element, grouped by window: type, label, `#id`, center `c=x,y` (0–1 fractions), and flags (`click`, `focus`, `disabled`, `covered`, …). The soft keyboard collapses to one `[keyboard …]` line. |
| `--raw` | Return the unpruned tree (no keyboard detection; not combinable with `--flat`, `--summary`, `--diff` or `--selector`). |
| `--summary` | Per window, and in total: `elements`, `content` (text, description, placeholder or image), `clickable` and `text` node counts (JSON). |
| `--diff <baseline.json>` | Compare the live layout with one saved by `dump layout > baseline.json` (JSON). Elements pair within a window by id, then key, then label and type, then type with overlapping boxes; each pair reports `by`, its `iou` (boxes are 0–1 fractions, so layouts from different resolutions compare) and `changed` fields. Unpaired ones are listed as `missing` and `extra`, and `similarity` (0–1) is the sum of pair IoUs (halved when a field changed) over pairs plus missing plus extra. Exits 0 either way. |
| `--selector <expr>` | List only the elements matching this expression (see [Selectors and windows](#selectors-and-windows)), numbered with the index its `[n]` suffix picks; JSON `{ display, selector, matches }`, or one line each with `--flat`. Soft-keyboard keys are left out, as `input` and `wait` leave them out. |
| `--window <id>` | Only this window (`[window <id> …]` in `--flat`, or `dump windows`). The whole screen is still dumped, so an overlay in another window still marks elements `covered`. |
| `--device <serial>` | Target device serial. |

The pruned output marks elements as `covered` when a later layer with a visible background (a dialog scrim, an overlay, the keyboard) paints over their center, so a tap there would land on that layer instead. A fully transparent layer that only intercepts touches is not detected. Placeholder text is reported as `hint`, disabled components as `disabled`, and components with `visible: false` as `hidden`. The node where a window starts carries its `windowId`. The JSON result also carries `keyboard: { shown, bundle, b }`.

```text
$ oniro-app dump layout > before.json
$ oniro-app input --type click --target "Hello World"      # the text becomes "Welcome"
$ oniro-app dump layout --diff before.json
layout similarity 0.978: 28 matched (1 moved, 1 changed), 0 missing, 0 extra.     # stderr; the JSON follows on stdout
{ "similarity": 0.978, "matched": [ …, { "by": "id", "baseline": { "id": "HelloWorld", "text": "Hello World", … },
  "current": { "id": "HelloWorld", "text": "Welcome", … }, "iou": 0.766, "changed": ["text"] } ], "missing": [], "extra": [], … }
```

```text
$ oniro-app dump layout --flat
# display 1080x2400; c = element center as 0-1 fractions (input --fx/--fy), or act by label with input --target "<text>"
[window 92 com.example.app]
Text "Sign in" c=0.500,0.180
TextInput hint="you@example.com" c=0.500,0.320 click focus
Button "Sign in" c=0.500,0.520 click
[keyboard 41 dev.patrickgold.florisboard] up — dismiss with input --type hideKeyboard

$ oniro-app dump layout --selector 'type=Button,text*=Sign' --flat
# display 1080x2400; 2 element(s) match "type=Button,text*=Sign"; append [n] to the selector to act on one
[0] Button "Sign in" #signIn c=0.361,0.214 click (window 92 com.example.app)
[1] Button "Sign up" #signUp c=0.631,0.214 click (window 92 com.example.app)
```

#### Selectors and windows

`input`, `wait`, `screenshot` and `dump layout` take `--selector <expr>` as an alternative to `--target` / `--target-id` / `--target-type`, which stay the default and keep their behaviour. A selector is exact where `--target` is forgiving: values compare case-sensitively, and every clause must hold. It is evaluated over the same pruned tree `dump layout` prints, so what you see there is what you can select.

**Attribute selectors** are comma-separated `key<op>value` clauses, optionally followed by an index:

| Keys | |
| --- | --- |
| `text`, `desc` (or `description`), `hint`, `id`, `key`, `type` | Strings as `dump layout` shows them. `key` falls back to `id`; `type` is the component type (`Button`, `TextInput`, `Column`, …). |
| `enabled`, `focused`, `checked`, `selected`, `visible`, `clickable`, `longClickable`, `checkable`, `scrollable` | `true` or `false`. `visible` means drawn and not `covered` by an overlay. |

| Operator | Matches when the value… |
| --- | --- |
| `=` | equals |
| `*=` | contains |
| `^=` | starts with |
| `$=` | ends with |
| `/=` | matches a JavaScript regular expression; flags after a slash (`text/=^sign/i`) |

Spaces inside a bare value are kept (`text=Sign in`); quote a value that holds `,`, `[`, a quote or edge spaces (`text="a, b"`, `id/="^item[0-9]$"`), with `\` escaping inside quotes. A key may appear once. An unknown key is an error, not an empty match.

The `[n]` suffix picks the n-th match, 0-based, in paint order: the list `dump layout --selector` prints. `[-1]` or `[last]` is the last one. The picked element must be on screen and not covered. Without an index, the selector picks the way `--target` does: covered elements are skipped, clickable matches preferred, a label inside a clickable match counts as that match, and more than one candidate is an error listing them. `--target-index` does not combine with `--selector`.

**XPath** (`xpath=<expr>`) runs over the same tree, each element named after its component type (`node` when it has none) and carrying the keys above as attributes. The subset is deliberately small, and anything outside it is a parse error rather than a wrong answer:

| Supported | Example |
| --- | --- |
| `//` (any depth) and `/` (child) steps, from the top | `//Row/Button`, `/node/root/Text` |
| `*`, `.` and `..` | `//Column[@id="items"]/*`, `//Text[@id="b"]/..` |
| `[@attr="v"]`, `[@attr!="v"]`, `[@attr]` (has it) | `//Button[@enabled="false"]` |
| `contains`, `starts-with`, `ends-with`, `not`, `text()` (same as `@text`) | `//Button[contains(@text,"Sign")]` |
| `and`, `or`, parentheses | `//*[@id="ok" or @id="cancel"]` |
| `[n]` (1-based), `[last()]`, `[position()<3]` | `//Column/Text[2]` |
| `(path)[n]`: the n-th match of the whole path | `(//Button)[1]` |

As in XPath, `[n]` counts among the step's matches under one parent: `//Button[1]` is every Button that is its parent's first, while `(//Button)[1]` is the first Button on screen. Not supported: axis names (`child::`), unions (`|`), attribute steps (`/@text`), paths inside predicates, and other functions.

**`--window <id>`** restricts dump, selection and screenshot to one window. Window ids are the `WinId` column of `hidumper -s WindowManagerService -a -a`: `dump windows` lists all of them, `dump layout --flat` shows the on-screen ones in its `[window <id> <bundle>]` headers, and the JSON tree carries `windowId` on each window's root. The layout is still dumped whole and then filtered, so overlays from other windows still count; `dump layout` and `input` fail with the list of on-screen windows when the id is not among them. Window ids come from uitest's `hostWindowId` attribute, which this was verified with on an API 26 device; deveco-cli notes that uitest's own `dumpLayout -w` / `-d` flags need API 20 or newer, and `--window` does not use them.

```bash
oniro-app input --type click --selector 'type=Button,text*=Sign[1]' --window 92
oniro-app wait --selector 'xpath=//Text[@id="status" and contains(@text,"Signed")]' --timeout 5000
oniro-app wait --selector 'id=spinner' --gone
oniro-app screenshot --selector 'xpath=//Column[@id="items"]' -o items.jpeg
oniro-app dump layout --window 92 --flat
```

#### `input` / `gesture` — inject UI input

`input` injects a single event via `uitest uiInput`. Give the start point one way: an on-screen element (`--target`, or `--selector`), 0–1 fractions of the display (`--fx`/`--fy`, as read from `dump layout` or the screenshot grid), or pixels (`--x`/`--y`).

| Flag | Description |
| --- | --- |
| `--type <type>` | **Required.** One of `click`, `doubleClick`, `longClick`, `swipe`, `drag`, `fling`, `keyEvent`, `inputText`, `clearText`, `hideKeyboard`. |
| `--target <text>` | Act on the center of the element whose text, description, or placeholder matches (case-insensitive; exact matches win, else substring). Covered elements and soft-keyboard keys are skipped and clickable ones preferred; if the keyboard hides the element, it is dismissed first. |
| `--target-id <id>` / `--target-type <type>` | Match by id/key, or restrict to a component type (e.g. `Button`, `TextInput`). |
| `--target-index <n>` | Pick the n-th (0-based) of several matching elements; without it, an ambiguous match fails and lists the candidates. |
| `--selector <expr>` | Instead of `--target*`: act on the element an attribute selector or `xpath=` expression picks (see [Selectors and windows](#selectors-and-windows)). |
| `--window <id>` | Only look for the element in this window; fails when the window is not on screen. |
| `--fx <fraction>` / `--fy <fraction>` | Start point as 0–1 fractions of the display. |
| `--fx2 <fraction>` / `--fy2 <fraction>` | End point as fractions (swipe / drag / fling). |
| `--x <px>` / `--y <px>` | Start point in pixels. |
| `--x2 <px>` / `--y2 <px>` | End point in pixels (swipe / drag / fling). |
| `--speed <px-per-s>` | Velocity for swipe / drag / fling. |
| `--key <key>` | For `keyEvent`: `Back` / `Home` / `Power`, a name (`Delete`, `Enter`, `Tab`, `Escape`, `MoveHome`, `MoveEnd`, `ForwardDelete`, …), a letter, a KeyCode id, or a combo of up to three keys like `Ctrl+A`. |
| `--text <text>` | Text for `inputText`. |
| `--clear` | `inputText`: clear the field (Ctrl+A, Delete) before typing. |
| `--hide-keyboard` | Dismiss the soft keyboard afterwards, if it is up. |
| `--device <serial>` | Target device serial. |

`clearText` taps the field, then sends Ctrl+A and Delete. `hideKeyboard` presses Back only when the soft keyboard is on screen, so it never navigates away.

```bash
oniro-app input --type inputText --target "you@example.com" --text 'me@example.com'
oniro-app input --type inputText --target-id password --clear --text 'secret' --hide-keyboard
oniro-app input --type click --target "Sign in" --target-type Button
oniro-app input --type click --selector 'type=Button,id=signIn'
oniro-app input --type swipe --fx 0.5 --fy 0.8 --fx2 0.5 --fy2 0.3
```

`gesture` injects a multi-waypoint path:

| Flag | Description |
| --- | --- |
| `--waypoints <json>` | **Required.** JSON array of pixel waypoints `[{"x":..,"y":..,"t":..}]` (`t` = ms from start). |
| `--fractions` | Waypoint `x`/`y` are 0–1 fractions of the display instead of pixels. |
| `--hold-start <ms>` / `--hold-end <ms>` | Hold at the first/last point before moving/lifting (routes via `uinput`). |
| `--device <serial>` | Target device serial. |

```bash
oniro-app gesture --waypoints '[{"x":200,"y":600,"t":0},{"x":200,"y":200,"t":400}]'
```

## Output & exit codes

- **Results → stdout.** Plain text by default; `--json` (where supported) writes `JSON.stringify(..., null, 2)`. Read/observe commands (`sdk list`, `cmdtools status`, `templates list`, `devices`, `wait --log` / `--target` / `--selector`, `dump windows`, `watch`, `lint`, `check arkts`, `screens`, `api search`, `api show`, `app apply`, `app verify`, `build`, `test`) accept `--json` (and `screenshot` with `--contact-sheet` or `--diff`, `app launch` with `--smoke`); `dump` emits JSON unless `--flat`; action-only commands do not.
- **Progress & logs → stderr.** stdout stays clean for machine consumers, so `oniro-app create … > path.txt` or `oniro-app devices --json | jq` work cleanly.
- **Exit code.** `0` on success, non-zero on failure (the error message is written to stderr). `app launch --smoke` and `app apply --smoke` exit 1 when the smoke verdict fails. Set `ONIRO_DEBUG=1` to also print full stack traces.
- **Global options go before the command** (`oniro-app --version`), so `hdc` can pass its arguments through untouched.

## Configuration

The CLI reads paths and URLs from environment variables. All are optional; defaults match the layout used historically by this project. `${userHome}` inside any value expands to the current user's home directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ONIRO_SDK_ROOT_DIR` | `~/setup-ohos-sdk` | SDK install root |
| `ONIRO_CMD_TOOLS_PATH` | `~/command-line-tools` | Command-line tools install root |
| `ONIRO_EMULATOR_DIR` | `~/oniro-emulator` | Emulator install root |
| `ONIRO_HAP_PATH` | `entry/build/.../entry-default-signed.hap` | Default `.hap` used by `app install` (relative to the project) |
| `ONIRO_DEVICE_SERIAL` | (unset) | Device every device command addresses when `--device` is not given (also read as `DEVICE_SERIAL`) |
| `ONIRO_HDC` | the cmd-tools `hdc` | `hdc` binary to use instead, e.g. a wrapper for a remote device |
| `ONIRO_SDK_URL_BASE` | `https://repo.huaweicloud.com/openharmony/os` | Base URL for SDK downloads (point at a private/CI mirror) |
| `ONIRO_CMD_TOOLS_URL_LINUX` | Huawei mirror, x64 5.1.0.840 | Override the Linux cmd-tools URL |
| `ONIRO_CMD_TOOLS_URL_WINDOWS` | (unset) | Self-hosted Windows cmd-tools URL |
| `ONIRO_CMD_TOOLS_URL_MAC` | (unset) | Self-hosted macOS cmd-tools URL |
| `ONIRO_EMULATOR_URL` | Latest `oniro_emulator.zip` | Emulator download URL |
| `ONIRO_TMP_DIR` | `<install root>/.oniro-tmp` | Scratch directory for download/extract temporaries (see [Temporary space](#temporary-space)) |
| `ONIRO_APPLICATION_CERT_PATH` | (unset) | External application-cert chain to use when signing system apps |
| `ONIRO_HARMONYOS_SDK_PATH` | autodetected | HarmonyOS SDK: a DevEco Studio or HarmonyOS command-line-tools install, or its `sdk` directory |
| `ONIRO_HARMONYOS_AUTH_DIR` | `~/.oniro/harmonyos` | Where the encrypted Huawei account token is stored |
| `ONIRO_HARMONYOS_SIGNING_DIR` | `~/.ohos/config` | Where generated HarmonyOS signing material (p12/csr/cer/p7b) is written |
| `ONIRO_CACHE_DIR` | `~/.oniro/cache` | Where caches go: the SDK declaration index of `api search` / `api show` |
| `ONIRO_DEBUG` | (unset) | Set to `1` for full stack traces on error |

### Temporary space

`sdk install`, `cmdtools install`, and `emulator install` download a multi-GB archive and
extract it in a scratch directory before moving the result into place. That scratch directory
lives **next to the install target** — `.oniro-tmp` beside the SDK root, the command-line-tools
directory, or the emulator directory — for two reasons:

- The system temp dir is not involved. On many Linux systems `/tmp` is a **RAM-backed `tmpfs`**
  sized from available memory, so a machine with plenty of disk but little free RAM would run
  out of "disk" mid-download.
- Temporaries and their destination share a filesystem, so finishing an install is a rename
  rather than a multi-GB copy across a device boundary.

Override it per command or globally when the install target's filesystem is the cramped one:

```bash
oniro-app cmdtools install --tmp-dir ~/.cache/oniro-tmp
export ONIRO_TMP_DIR=~/.cache/oniro-tmp        # applies to all three install commands
```

Precedence is `--tmp-dir` → `ONIRO_TMP_DIR` → `<install root>/.oniro-tmp`. The directory is
created if it does not exist; the per-run folder inside it is removed afterwards, and so is
`.oniro-tmp` itself once empty. If the install target's parent cannot be written to at all
(a root-owned prefix, a read-only mount), the system temp dir is used instead and the CLI says
so. When space runs short, the install fails with a message naming the directory, how much room
it needed, whether that directory is RAM-backed, and this flag — rather than crashing part-way
through.

`cmdtools install` stages the new tools inside the install directory and swaps them in only once
they are complete, so a failure leaves the existing tools as they were. The old tools are deleted
only after the swap, so the install directory's filesystem needs room for both versions at once.

**Command-line tools on Windows / macOS.** The Huawei mirror only publishes a Linux build of the command-line tools. On Windows and macOS you must either download the ZIP manually from the Huawei developer portal and install it with `oniro-app cmdtools install --from-zip path/to/commandline-tools-<platform>.zip`, or host the archive yourself and set `ONIRO_CMD_TOOLS_URL_WINDOWS` / `ONIRO_CMD_TOOLS_URL_MAC` so `cmdtools install` can fetch it.

## HarmonyOS apps

`oniro-app` builds and signs **HarmonyOS** projects as well as OpenHarmony ones. A project
is HarmonyOS when its product declares `runtimeOS: "HarmonyOS"` in `build-profile.json5`, as
DevEco Studio writes; every other project is OpenHarmony and behaves exactly as before.

The two paths differ in one way that matters:

| | OpenHarmony | HarmonyOS |
| --- | --- | --- |
| SDK | `oniro-app sdk install` downloads it | Ships inside DevEco Studio or the HarmonyOS command-line tools. Found automatically in Studio's default location or at the command-line-tools path; otherwise set `ONIRO_HARMONYOS_SDK_PATH` |
| Signing | `oniro-app sign` — fully offline, uses the SDK's development certificate | `oniro-app sign --harmonyos` — AppGallery Connect issues the certificate and profile |
| Account | none | a Huawei developer account (`oniro-app auth login`) |
| Network | none | required |
| Device | not required | one registered to the AGC team — a debug profile names the devices it is valid for |

### Workflow

```bash
oniro-app auth login                       # once per machine
oniro-app create --name MyApp --bundle com.example.myapp \
                 --location ~/projects --sdk 24 --template HarmonyOSApp
cd ~/projects/MyApp
oniro-app sign --harmonyos                 # registers each connected device that reports a UDID
oniro-app build
oniro-app app install && oniro-app app launch
```

Pass `--sdk` the API level of the installed HarmonyOS SDK (`apiVersion` in its
`default/sdk-pkg.json`). hvigor builds a HarmonyOS project only against the release its
`compileSdkVersion` names ("SDK component missing" otherwise), so `create` writes the
installed SDK's release, e.g. `6.1.1(24)`, and warns when `--sdk` asks for another one.

### `oniro-app auth`

| Command | What it does |
| --- | --- |
| `auth login [--timeout <s>]` | Opens the Huawei sign-in page and waits for the browser to redirect back to a loopback port (`http://127.0.0.1:<port>/callback`). The URL is also printed to stderr. |
| `auth logout` | Deletes the locally stored token. |
| `auth status [--json]` | Prints the signed-in account, and warns when it is not allowed to sign. Exits non-zero when signed out. |
| `auth team list [--json]` | Lists AGC teams; pass an id to `sign --harmonyos --team-id`. |

| `auth login` flag | Meaning |
| --- | --- |
| `--timeout <s>` | How long to wait for the sign-in (default 600). |
| `--port <n>` | Listen for the redirect on this port instead of a random one, so a tunnel can be set up before the login starts. |
| `--no-browser`, `--manual` | Do not open a browser. Print the URL, then finish the sign-in from the callback address pasted on stdin — or from a request to the loopback port, whichever comes first. |
| `--print-url` | Also write the sign-in URL to stdout, alone on its line, before waiting. |
| `--json` | Write JSON lines to stdout: `{"loginUrl","port","callbackUrl"}` before waiting, then `{"userId","userName","site","tokenPath"}` once signed in. |

The token is stored encrypted under `ONIRO_HARMONYOS_AUTH_DIR`. It is a credential: the
directory is created `0700` and the files `0600`.

#### Signing in from a headless host

After the sign-in, Huawei sends the browser to `http://127.0.0.1:<port>/callback?...` — which,
when the browser runs on another machine, is that machine, not the build host waiting for it.
Either of these completes the sign-in:

- **Paste the address.** Run `oniro-app auth login --manual`, open the printed URL anywhere and
  sign in. The browser then fails to load the `127.0.0.1` page; copy the whole address from its
  address bar (or just the part after `?`) and paste it into the waiting terminal. A paste that
  is not this sign-in's callback (another attempt's, or a truncated one) is reported, and the
  next line is read.
- **Tunnel the port.** Pick a port, open the tunnel from the machine with the browser, then sign in:

  ```bash
  ssh -L 8765:127.0.0.1:8765 build-host          # on the machine with the browser
  oniro-app auth login --no-browser --port 8765  # on the build host
  ```

  Use the same port on both ends: the page redirects to the port in its URL.

Scripts can read the URL without scraping stderr: `--print-url` writes it alone to stdout, and
`--json` writes `{"loginUrl","port","callbackUrl"}` as the first line, then the account once
signed in.

### `oniro-app sign --harmonyos`

Mirrors DevEco Studio's automatic signing:

1. generates a local p12 keystore and a CSR (via the SDK's `hap-sign-tool.jar`, so a JDK is needed — DevEco Studio's bundled JBR is used when present);
2. has AppGallery Connect issue a debug certificate for that CSR;
3. registers every connected device's UDID with the team — no device is needed when the team already has some registered (from another machine, or by DevEco Studio). A device that does not report a UDID (`hdc shell bm get -u`; some OpenHarmony builds do not) cannot be registered, so the profile does not cover it;
4. issues a debug provisioning profile naming that certificate, all of the team's registered devices, and any ACL-gated permissions the project requests;
5. writes an encrypted `signingConfigs` entry into `build-profile.json5`, leaving other entries untouched.

Material lands in `ONIRO_HARMONYOS_SIGNING_DIR` (default `~/.ohos/config`, the directory
DevEco Studio also uses) and is **reused**, without contacting AGC for anything, while it is
still valid: same bundle name and team, unexpired, naming the attached devices and requested
permissions, and wired into this project's `build-profile.json5`. Certificates are a small
per-team quota; `--force` regenerates anyway.

AGC's debug certificate and profile last 14 days, after which a device refuses to install the
HAP. `sign --harmonyos` therefore ends by naming the profile's type and expiry, e.g.
`(profile names 6 device(s), debug, valid until 2026-10-01 11:50 UTC)`, and
`oniro-app app verify <hap>` reports both, with the days left, for a built HAP.

The AGC certificate is named `oniro_debug_<team>.cer`, distinct from DevEco Studio's
`auto_debug_<team>.cer`: each tool replaces only its own certificate when regenerating, so
using both on one team does not revoke the other's signing material.

| Flag | Meaning |
| --- | --- |
| `--harmonyos` | Use the AGC path instead of the offline OpenHarmony one |
| `--team-id <id>` | AGC team to issue under (default: the account's own id) |
| `--product <name>` | Product to sign (default `default`) |
| `--force` | Regenerate even when the existing material is still valid |
| `--hap <file>` | Sign a prebuilt HAP instead of a project (below) |
| `--out <file>` | With `--hap`: where to write the signed HAP |

### Signing a prebuilt HAP

`oniro-app sign --harmonyos --hap <file>` signs a HAP you have no project for: an unsigned build
output, or a HAP signed with other material (its signature is replaced). The bundle name and the
ACL-gated permissions come from the `module.json` packed in the HAP; everything else works as for
a project. AGC issues the certificate and debug profile, which name the team's registered devices.

```sh
oniro-app sign --harmonyos --hap entry-default-unsigned.hap   # writes entry-default-signed.hap
oniro-app sign --harmonyos --hap app.hap --out /tmp/app.hap
oniro-app app install entry-default-signed.hap
```

The signed copy goes next to the input by default: `<name>-unsigned.hap` becomes
`<name>-signed.hap`, `<name>.hap` becomes `<name>-signed.hap`, and `<name>-signed.hap` becomes
`<name>-resigned.hap`, so the input is never overwritten unless `--out` names it. The output is
never left half-written either: the HAP is signed to a temporary file, then moved into place.
`--apl`, `--acls` and the other OpenHarmony profile flags are refused here, since AGC decides
the profile and the ACLs come from the HAP.

The material is kept per bundle name (`hap_<bundle>_…` in `ONIRO_HARMONYOS_SIGNING_DIR`), with its
keystore password stored encrypted next to it, and is reused while it is still valid, as for a
project. All of oniro-app's material for a team, project or HAP, shares the team's one
`oniro_debug_<team>.cer` certificate in AGC. Regenerating any of it deletes that certificate and
has a new one issued, and the other material is not told: it is still reused locally, but was
issued for a certificate AGC no longer has. If it then stops installing, regenerate it with
`--force`. Only stage-model HAPs are supported, and a HAP built for OpenHarmony is refused, since
a HarmonyOS device would not run it.

### Account regions

Accounts from every Huawei region can sign. Sign-in redirects to the account's own region,
which then decides the hosts every later call goes to — the ones DevEco Studio resolves
through Huawei's routing service:

| Region | Sign-in host | AGC signing host |
| --- | --- | --- |
| `CN` | `cn.devecostudio.huawei.com` | `connect-api.cloud.huawei.com` |
| `EU` | `de.devecostudio.huawei.com` | `connect-api-dre.cloud.huawei.com` |
| `SG` | `sg.devecostudio.huawei.com` | `connect-api-dra.cloud.huawei.com` |
| `RU` | `ru.devecostudio.huawei.com` | `connect-api-drru.cloud.huawei.com` |

The whole flow has been run with an `EU` account. Huawei's own CLI accepts only `CN` accounts.

### Limitations

- **Real-name verification is not required**, but an account without it must have accepted
  the current HUAWEI Developer Basic Service Agreement — in AppGallery Connect, or by running
  automatic signing once in DevEco Studio. `oniro-app auth status --json` reports it as
  `developerAgreement`; `oniro-app` checks it but never accepts it for you.
- A refusal from AGC surfaces as a permissions or not-enrolled error, not as a crash.
- The AGC endpoints are private and undocumented, and can change without notice. See
  `packages/core/src/harmonyos/NOTICE.md` for provenance and attribution.

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

An app that declares a privileged extension ability, such as an `AccessibilityExtensionAbility`, also needs `AllowAppUsePrivilegeExtension` in the profile's `app-privilege-capabilities`; without it the install fails with `9568344 not allow use privilege extension`. Pass it, and any other privilege (`AllowAppMultiProcess`, `AllowAppDesktopIconHide`, …), via `--app-privilege-capabilities`:

```bash
oniro-app sign --apl system_core --acls ohos.permission.ACCESSIBILITY_EXTENSION_ABILITY \
    --app-privilege-capabilities AllowAppUsePrivilegeExtension
```

Apps like these usually also call system APIs (`@systemapi`), which the public SDK that `sdk install` downloads leaves out: the build fails with errors such as `'config' is not exported from Kit '@kit.AccessibilityKit'`. Build them against the full OpenHarmony SDK, installed with `sdk install --from-archive` (see [Full SDK](#full-sdk)).

The `signingConfigs` block written to `build-profile.json5` mirrors the names used by the project's `products[*].signingConfig` (e.g. `applications/standard/systemui` uses `release`, `launcher` uses `default`). If the project has no products section, `default` is used, and a product that names no `signingConfig` is pointed at it.

## Programmatic use

Everything the CLI does is exposed as a library by [`@oniroproject/core`](https://www.npmjs.com/package/@oniroproject/core), so you can embed the same SDK/build/sign/emulator/`hdc` functionality in an editor extension, an MCP server, or your own tooling. See that package's README for the API reference.

## License

Apache-2.0 — see [LICENSE](https://github.com/eclipse-oniro4openharmony/oniro-app-builder/blob/main/LICENSE).
