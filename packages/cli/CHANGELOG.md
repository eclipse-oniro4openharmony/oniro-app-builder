# @oniroproject/oniro-app

## 0.20.1

### Patch Changes

- c9500b2: `sign --product <name>` now reads the SDK level from that product's `compileSdkVersion`, not from
  the first product's. A project that also targets HarmonyOS, with its HarmonyOS product listed
  first, can sign its OpenHarmony product (`oniro-app sign --product oniro`) instead of failing
  with "Could not detect project SDK version". `build --product` finds the SDK the same way, for
  its missing-SDK check and for the SDK it names in failures. Without `--product`, the first
  product is used, as before.
- Updated dependencies [c9500b2]
  - @oniroproject/core@0.18.4

## 0.20.0

### Minor Changes

- 4918af9: New `store` command group: publish apps to the Oniro App Store from a terminal or CI job.

  - `store login --token <oas_…>` checks an API token created on the store website and saves it
    (`~/.oniro/store/credentials.json`, mode 0600, keyed by store URL); `store logout` and
    `store whoami` manage it. `ONIRO_STORE_TOKEN` wins over the saved token, and `ONIRO_STORE_URL`
    or `--url` picks the store (default `https://store.iparo.app`).
  - `store publish <file.hap|file.app>` reads the bundle name from the package, creates the listing
    on the first publish (`--name`, `--description`, `--category`, `--tags`, `--icon`, `--vendor`,
    `--source-url`) and adds a new version afterwards.
  - `store register-release --repo owner/name --tag v1.2.0 --asset app.app` publishes a package
    that stays hosted on a public GitHub release; its sha256 comes from GitHub's digest, a local
    `--file`, or a download.
  - Requests honour `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, and wait up to 15 minutes for the
    store to check a large package. A token with stray spaces or line breaks is refused without
    being echoed.

### Patch Changes

- 11043ad: `screenshot`: when every capture attempt fails, the error no longer blames a
  2 s RenderService stall. It says RenderService returned no image each time and
  shows how to read the reason from the device log (`hilog`). The end-to-end CI
  failure this hint was written for was in fact an emulator image bug (fixed in
  Oniro Emulator v7.0.1).
- Updated dependencies [11043ad]
  - @oniroproject/core@0.18.3

## 0.19.2

### Patch Changes

- 7ea39ed: Fixes:

  - `screenshot` retries a capture that wrote no file instead of failing with
    `hdc file recv ... no such file or directory`. `snapshot_display` gives up when
    RenderService does not deliver a frame within 2 s, which happens now and then
    while an app starts on the emulator (the flaky screenshot step of the
    end-to-end CI). Up to three attempts are made, `--burst` retries each frame the
    same way, and when every attempt fails the error quotes `snapshot_display`'s
    own message.
  - Each screenshot uses its own file on the device. With one fixed name, the
    background clean-up of a previous capture in the same process (`serve`) could
    delete the next capture before it was pulled.

- Updated dependencies [110751b]
- Updated dependencies [7ea39ed]
  - @oniroproject/core@0.18.2

## 0.19.1

### Patch Changes

- d5b32db: Fixes:

  - Device commands now work on a screen rotated to landscape. They used the
    panel's portrait size, so `dump layout` reported `display 1080x2400` with
    fractions above 1. `input --target`, `--selector` and `--fx/--fy` tapped the
    wrong place (x was clamped to the portrait width). `screenshot --target` and
    `--selector` cropped a sliver at the edge of the image instead of the element.
    The display size now comes from RenderService plus the display manager's
    `ScreenRotation`, so width and height follow the rotation. `screenshot`,
    `record` and the lock-screen swipe use the same size.

- Updated dependencies [d5b32db]
  - @oniroproject/core@0.18.1

## 0.19.0

### Minor Changes

- 4abd3ab: Features:

  - New `docs sync`, `docs search <query...>` and `docs show <path>`: the OpenHarmony application-development
    documentation (gitcode.com/openharmony/docs, `en/application-dev`) of the release matching the SDK, for what the
    SDK typings behind `api search` cannot say: how an API is used, a component's attributes, the business error codes
    a kit throws, platform behaviour (lifecycle, permissions, threads). `docs sync` clones one release's tree (a
    partial, sparse clone without figures, about 100 MB; `6.1.0.x` → `OpenHarmony-6.1-Release`, or `--ref`) under
    `<sdkRootDir>/docs` (`ONIRO_DOCS_DIR`). `docs search` ranks documents containing every word by where the words
    occur (title, headings, path, body), names the matching sections and exits 1 on none; `docs show` prints one
    document or one section by `--heading`, images dropped, cut at `--lines`. The SDK is `--api`, `--sdk` or the
    project's `compileSdkVersion`, as for `api search`. `--json` on each.
  - `serve mcp` exposes them as `docs_search` and `docs_show` (read-only; `isError` with the sync instruction when the
    release is not cloned).
  - Core: `syncDocs`, `docsRefFor`, `readSdkRelease`, `getDocsRootDir`, `docsDirFor`, `docsTree`, `DocsIndex`
    (`load`, `search`, `show`), the `docsDir` config key.

### Patch Changes

- Updated dependencies [4abd3ab]
  - @oniroproject/core@0.18.0

## 0.18.0

### Minor Changes

- 4379401: Features:

  - New `api search <query...>`: a ranked search of what the SDK at one API level declares, read from its own typings:
    the ArkTS API (`ets/api`, `ets/arkts`), the global ArkUI components and decorators (`ets/component`), with the kit
    that re-exports each symbol (`ets/kits/@kit.*.d.ts`), and the Node-API headers (`node_api*.h`,
    `js_native_api*.h`, `napi/*.h`). Each hit has the symbol, its kind (class, interface, function, method, property,
    enum, namespace, component, decorator, macro, ...), kit, module, how to import it, `@since`, `@deprecated` with
    `@useinstead`, `@syscap`, `@systemapi`, `file:line`, the declaration text and the first doc line. `--kit`,
    `--kind`, `--lang`, `--limit`, `--no-deprecated`, `--no-systemapi`, `--json`.
  - New `api show <symbol>`: an exact lookup (`NavPathStack.pushPathByName`, `router.pushUrl`, `@Local`) that exits 1
    when the SDK does not declare the symbol, naming the other installed SDKs that do (with their `@since`) and the
    closest names this SDK declares. `api index` builds or refreshes an index.
  - The SDK is `--sdk`, `--api`, the project's `compileSdkVersion`, or the newest installed one. The index is built on
    first use with the SDK's bundled TypeScript (about 3 s for API 23) and cached under `~/.oniro/cache`
    (`ONIRO_CACHE_DIR`, config key `cacheDir`), rebuilt when the SDK is reinstalled.
  - Core exports `loadApiIndex`, `buildApiIndex`, `searchApi`, `showApi`, `suggestApiSymbols`, `findApiInOtherSdks`,
    `resolveApiSdk` and the `ApiEntry` and `ApiIndex` types.

- 97dd96c: Features:

  - New `app verify <hap> [--json]` (#24): runs the SDK's `hap-sign-tool verify-app`, then reports whether the
    signature is valid, the certificate chain (leaf first) and its root, whether the HAP carries OpenHarmony
    development material or a HarmonyOS certificate from AppGallery Connect (`Huawei CBG Root CA G2`), and the
    profile's type, bundle name, apl, app-feature, device count, validity and days left. A HAP is invalid when it is
    unsigned, its signature is rejected, a certificate or AGC profile has expired, the profile names another
    certificate or bundle, or a HarmonyOS HAP carries OpenHarmony development material. Exits 0 valid, 1 invalid,
    2 could not verify (no java or hap-sign-tool.jar).
  - `sign --harmonyos` names the profile's type and expiry (#24):
    `Signing configs ready for … (profile names 6 device(s), debug, valid until 2026-10-01 11:50 UTC)`. The
    OpenHarmony `sign` and `sign --hap` name the profile type, apl and certificate expiry.
  - Core exports `verifyHap`, `verifyHapExitCode`, `formatHapVerification`, `findHapSignTool`,
    `parseProvisionProfile`, `describeProfileValidity`, `formatUtc` and `describeSigningMaterial`;
    `readProvisionProfile` also returns the type, issuer, apl, app-feature, `notBefore` and the distribution
    certificate; `generateSigningConfigs` returns a summary of the material instead of nothing;
    `harmonyOsAutoSign`/`harmonyOsSignHap` return `profileType` and `notAfter`, and `signOpenHarmonyHap` `material`.

- 96cdcc0: Features:

  - `auth login` completes when the browser is not on the build host (#20). `--manual` (or `--no-browser`) does not
    open a browser: it prints the URL, then takes the callback address the browser ends up on, pasted on stdin as the
    whole URL or its query, through the same checks as a request to the loopback port. `--port <n>` listens on a fixed
    port, so an `ssh -L <n>:127.0.0.1:<n>` tunnel can be set up beforehand. `--print-url` writes the URL alone to
    stdout and `--json` writes `{"loginUrl","port","callbackUrl"}` then the account as JSON lines, so scripts need not
    scrape stderr.
  - Core: `session.login()` takes `port`, `openBrowser` and `pastedCallbacks` (`HarmonyOsLoginOptions`), and
    `onLoginUrl` receives the port.

- a8fac5f: Features:

  - `build --json` prints one result object whether the build passes or fails (a failed build still exits 1):
    `ok`, `exitCode`, `durationMs`, `failedTask`, `diagnostics`, `summary`, `discoveredHaps`, `warnings`, `error` and
    `rawTail` (the last 200 lines of output, colour codes removed). Each diagnostic has `severity`, `source` (`arkts`,
    `hvigor`, `native`, `ohpm` or `sdk`), `code`, `rule`, `message`, a project-relative `file`, `line`, `column` and the
    hvigor `task`. hvigor prints the ArkTS block twice; each diagnostic is listed once.
  - A failed build lists its errors on stderr, one per line, after hvigor's output.
  - When the project uses kit symbols its SDK lacks but a newer installed SDK declares, the build names that API level
    in an `sdk` diagnostic and in the error, instead of pointing at the full SDK (#22).
  - Core exports `buildWithDiagnostics` (returns `ok: false` instead of throwing for a failed build or a missing SDK),
    `BuildFailedError` (what `buildHap` now throws when ohpm or hvigor fails), `parseBuildOutput`,
    `sdkTooOldDiagnostic` and `missingSdkSymbols`. `BuildHapResult` gains `diagnostics` and `summary`.

  Fixes:

  - A failed native build no longer gets the hint that hvigor cannot find the SDK: hvigor wraps every native failure
    in its catch-all `00308018 Unknown Error`, which was read as a missing SDK.

- 49e3592: Features:

  - A failed build names the SDK it compiled against, e.g. `Built against HarmonyOS 5.1.0 (API 18) at
~/command-line-tools/sdk.`, and `build --json` reports it as `sdk` (`runtimeOS`, `displayName`, `version`, `api`,
    `path`), for a build that passed too (#22).
  - When the ArkTS errors are missing properties or names (`Property '…' does not exist on type …`,
    `Cannot find name '…'`) in code under `oh_modules/`, the build adds a `warning` `sdk` diagnostic, also in the
    error. It names the dependency and the SDK and says the dependency may need a newer API level, with how to get
    one: newer command-line tools for HarmonyOS, `sdk install` for OpenHarmony. It reads only the compiler messages.
  - Core exports `resolveBuildSdk`, `describeBuildSdk`, `dependencyApiDiagnostic` and `ohModulesPackage`;
    `BuildHapResult`, `BuildReport` and `BuildFailedError` gain `sdk`.

- dbc01e0: Features:

  - New `check arkts [project-dir]`: the SDK's own ArkTS type check and linter (what the build's `CompileArkTS` runs),
    plus the ArkUI component-model and project rules hvigor enforces later in a build, in seconds and without hvigor,
    a device or codelinter. It checks against the SDK the project compiles with (`compileSdkVersion`, or the HarmonyOS
    SDK for a HarmonyOS project). `--files` checks only the files given, `--fix` applies the fixes it can verify and
    reverts any that adds an error, `--json` prints `ok`, `completed`, `diagnostics` (the `build --json` shape, with
    `source: "arkts-check"`), `fixed` and `summary`. Exits 0 when clean, 1 on an error, 2 when the checker could not
    run. The checker is deveco-cli's `arkts-check.cjs` (MIT), adapted to take the SDK directory. Beyond upstream,
    `--fix` adds the missing `export` when the imported file exports nothing at all ("File '...' is not a module"),
    not only when it exports something else.
  - `lint --engine arkts` runs `check arkts`.
  - `lint` exits 2 when codelinter reports that its run was incomplete (for example with command-line tools of the
    other flavour), since a clean report then says nothing; `--allow-incomplete` restores exit 0.
  - Core exports `checkArkts`, `resolveArktsCheckSdk`, `parseArktsCheckOutput` and `arktsCheckerScript`, and ships
    `vendor/deveco-cli/`.

- 2c05d4c: Features:

  - `cmdtools install --force` says what it replaces before deleting it (#25), e.g.
    `Replacing command-line tools 5.1.0.840 (HarmonyOS 5.1.0, API 18, hvigor 5.18.5) with 6.1.1.280 (HarmonyOS 6.1.1,
API 24, hvigor 6.24.2).`. Further lines say when hvigor changes major version, when the new release is older, and
    how to go back. The final line names the installed release, and without `--force` the message names the release
    already installed.
  - `installCmdTools` returns `{ path, installed, previous? }` with both releases' `CmdToolsInfo` (version, flavour,
    SDK, tool versions), and core exports `describeReplacement`.

- 9a2d6c6: Features:

  - New `doctor [project-dir]`: one verdict on whether this machine can build, check, sign, install and test, with a
    fix for each problem. It checks node and java, the SDK the project compiles with (`--fix` installs it), that the
    command-line tools are a complete install (#16) and of the project's flavour, a `check arkts` self-test, hdc and a
    reachable device at the project's API, the signing material, and free disk space. `--json` adds the versions in
    use (tools, SDK, java, hdc, device API), so a change between two runs shows (#25). Exits 1 when a check fails.
  - Core exports `runDoctor` and its checks, and `resolveProjectSdkDir`.

- d860755: Features:

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

- 1ab2486: Features:

  - The HarmonyOS SDK is no longer invisible (#21). `cmdtools status` prints what the tools are, e.g.
    `Installed 6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2)`, then the SDK they bundle (name, API level, build,
    path) and the hvigor version; `--json` adds `version`, `sdk` and `tools` (hvigor, ohpm, codelinter, hstack).
  - `sdk list` says HarmonyOS SDKs come with the command-line tools (`cmdtools`) or DevEco Studio and lists the one a
    HarmonyOS build would use, with where it came from; `--json` appends it as a `flavour: "HarmonyOS"` entry and marks
    the others `flavour: "OpenHarmony"`.
  - The `cmdtools` description says it supplies the HarmonyOS SDK, and "No HarmonyOS SDK found" names
    `oniro-app cmdtools install`.
  - Core exports `readCmdToolsInfo`, `describeCmdTools`, `getHarmonyOsSdkListing` and `readSdkPkg`. `CmdToolsStatus`
    gains `version`, `sdk` and `tools`; `HarmonyOsSdk` gains `apiVersion` and `source`.

- 9d90668: Features:

  - `dump layout --summary`: per window, and in total, the element, content, clickable and text-node counts.
  - `dump layout --diff <baseline.json>`: compare the live layout with a saved `dump layout`. Elements pair within a
    window by id, key, label and type, then type with overlapping boxes; the result lists each pair's IoU and changed
    fields, the `missing` and `extra` elements, and a 0-1 `similarity`.
  - `screenshot --diff <baseline.jpeg> [--json]`: pHash and dHash distance, the share of pixels that changed, the
    contact sheet's mean change, and a `same` verdict.
  - `app launch --smoke` and `app apply --smoke` (`--smoke-delay <ms>`, `--smoke-screenshot <file>`): wake the
    screen, launch, wait for the process, screenshot after the delay, and report
    `{ smoke: { passed, failures, pid, alive, blankScreen, blankScore, screenshot, crash } }`. Exits 1 when the
    process did not start or died, a crash was recorded since the launch (`crash` holds the `logs crash` verdict),
    or the screen is blank (the deveco-cli smoke-inspector pattern).
  - Core exports `summarizeLayout`, `diffLayouts`, `parseLayoutBaseline`, `boxIoU`, `smokeCheck` (with an optional
    `crashProbe` hook for crash detection) and `smokeVerdict`, and an image module: `pHash`, `dHash`,
    `hammingDistance`, `compareImages`, `analyzeBlank` and their helpers, over greyscale pixels the caller decodes.

- 1872e01: Features:

  - New `logs crash`: fetches an app's newest faultlog from the device and says what happened. It classifies the log as
    `cpp_crash`, `js_crash`, `app_freeze`, `sample_stack` or `unknown` with a confidence, and reports the reason, the top
    frame, the first frame in the project's own code with `file`, `line` and `column` (for a native crash, the ArkTS
    code that called into it), the JS error name, message and stack, the native frames (library, symbol, build id) and,
    for a freeze, the binder chain and any deadlock. `--bundle` defaults to the project in the current directory,
    `--since` takes seconds or an ISO time, `--wait` polls until hiview has written the log, `--path` analyses a local
    file, and `--json` prints the verdict. The fetched log is saved under `--output` (`~/.oniro/faultlogs`).
  - `logs crash` also reads faultloggerd's crash records in `/data/log/faultlog/temp`. Some builds never turn an app's
    native crash into a faultlog (hiview rejects processdump at `/root/system/bin/processdump`), so the record is the
    only trace of it.
  - Core exports `latestCrash` (the newest fault of a bundle since a time, or null), `analyzeFaultLog`,
    `classifyFaultLog`, `listFaultLogs`, `readFaultLog`, the per-kind parsers and the frame and binder-chain helpers.
    The classifier and parsers are adapted from deveco-cli's `faultlog/` module (MIT); they also read the frame form
    devices print, `at f entry (file:line:col)`, which upstream's patterns miss.

- f13edd8: Features:

  - New `perf trace`: captures a `hitrace` trace on the device while the app cold-launches (`--launch`), a flow is
    replayed through the `replay` engine (`--flow <file>`), or for a fixed time (`--for <ms>`), pulls it and
    summarises it for the bundle: its UI frames (one `ReceiveVsync` slice on the main thread each, timed from the
    vsync, janky when longer than one refresh interval) with `total`, `janky`, `jankRate`, `p50Ms`, `p95Ms`, `maxMs`,
    `missedVsyncs` and the longest frames; the refresh rate from the vsync period; the cold start from `aa`'s
    `StartAbility` to RenderService compositing the first frame (`coldMs`, `firstFrameMs`, `processMs`); main-thread
    busy time (CPU time with `--categories …,sched`); and RenderService's own jank reports per scene.
    `--max-jank-rate <r>` and `--max-startup-ms <ms>` make it a gate: exit 0 when the capture completed, 1 when a
    threshold is exceeded (or the flow diverged), 2 when it could not capture. `--hiperf` also samples the app's
    process with `hiperf` and lists its top functions. `--out`, `--categories`, `--buffer-kb`, `--bundle`,
    `--ability`, `--no-wake`, `--json`.
  - New `perf summary <trace>`: the same summary and thresholds for a trace taken earlier.
  - New `perf_trace` tool in `serve mcp` (left out with `--read-only`: it launches the app and replays flows).
  - Core exports `perfTrace`, `evaluatePerfGate`, the hitrace text parser (`parseTraceText`, `parseTraceFile`,
    `TraceParser`), `summarizeTrace`, `parseHiperfReport` and their helpers. `trace_streamer` is not used.

- 8997e6e: Features:

  - New `replay <flow.json>`: runs a flow file (hand-written or recorded) on the device through the same path as
    `input --selector`, waiting for each step's selector before acting and for its `expect` after. It stops at the
    first step that fails and reports the step, the reason (`not-found`, `expect-not-found`, `wrong-screen`,
    `ambiguous`, `covered`, `action-failed`), a screenshot, the app's elements on screen, and the elements that match
    all but one clause of the selector. `--from` / `--to`, `--step-timeout`, `--screenshots <dir>` (one per step),
    `--fallback` (act on the recorded point when the selector is not found), `--launch`, `--no-wake`, `--json`. Exits
    0 when every step ran, 1 when the flow diverged, 2 when it could not run (invalid flow file, no device).
  - New `record --out flow.json`: runs uitest's recorder (`uitest uiRecord record -l`) until Ctrl+C or `--for <ms>`
    and writes a flow: each touch becomes a step on the element under the finger with the most specific stable
    selector for it, the touch point as fallback, and an `expect` element that appeared after it; soft-keyboard taps
    and typed keys become one `inputText` step per field. uitest only reports an event once the next touch has
    started, so its own widget and layout often show the next screen; `record` follows the multimodal input hilog
    for the touch-down times and matches each touch to the layout on screen at that moment. `--raw <dir>` keeps the
    raw recording.
  - Flow files are versioned JSON (`version: 1`, `bundle`, `ability`, `device`, `steps` with `action`, `selector`,
    `fallback`, `text`, `key`, `to`, `expect`, `waitMs`, `timeoutMs`, …), validated with every problem listed by
    path; the format is documented in the CLI README.
  - Core exports `replayFlow`, `recordFlow`, `flowFromRecording`, `parseFlow`, `readFlowFile`, `formatFlow`, the
    `Flow` types and the pure helpers behind them.

- ff5bb28: Features:

  - New `screens [project-dir]`: a static inventory of a project's pages and routes, from the sources of every module
    in `build-profile.json5`, with no build, SDK or device. Pages are the `@Entry` pages of `main_pages.json` (and
    `@Entry({ routeName })` named routes) and the `NavDestination`s registered in a route map (`routerMap`) or in a
    `.navDestination(builder)` builder that dispatches on the route name; unlisted `@Entry` structs and unregistered
    `NavDestination` structs are listed as unregistered. Each page has its content-node count (the component calls it
    renders through its custom components and `@Builder`s, layout containers excluded) and its routes out. Routes are
    the `router` `pushUrl`/`replaceUrl`/`pushNamedRoute`/`replaceNamedRoute` and `NavPathStack`
    `pushPath*`/`replacePath*`/`pushDestination*` call sites and `loadContent`, with literal, constant and local
    `RouterOptions` targets resolved. Placeholders are `TODO`/`FIXME` comments, placeholder-like text in code and
    `string.json` (`placeholder`, `lorem ipsum`, `coming soon`, `Hello World`, ...), empty `build()`s and pages with no
    content. Prints tables, or the inventory with `--json`. Exits 0, or 1 when the project cannot be read.
  - Core exports `inventoryScreens`, and `checkScreensAgainstSpec`, the G2 gate ("every spec screen has a page with at
    least k content nodes and every spec route has a push call site") as a pure function of the inventory, plus
    `pagesMatching`, `scanEts` and `LAYOUT_COMPONENTS`.

- 8a6f692: Features:

  - `--selector <expr>` on `input`, `wait` (including `--gone`), `screenshot` (crops to the element) and `dump layout`
    (lists only the matches, numbered), as an alternative to `--target` / `--target-id` / `--target-type`, which keep
    working unchanged. Attribute selectors: comma-separated `key<op>value` clauses over `text`, `desc`, `hint`, `id`,
    `key`, `type`, `enabled`, `focused`, `checked`, `selected`, `visible`, `clickable`, `longClickable`, `checkable`
    and `scrollable`, with `=`, `*=` (contains), `^=` (prefix), `$=` (suffix) and `/=` (regex, `/flags`), and a `[n]`
    suffix (0-based, `[-1]` / `[last]` from the end) that picks one match of the list `dump layout --selector` prints.
    `xpath=<expr>` evaluates a documented XPath subset over the same tree: `/`, `//`, `*`, `.`, `..`, `[@attr="v"]`,
    `[@attr]`, `!=`, `contains`, `starts-with`, `ends-with`, `not`, `text()`, `and` / `or`, `[n]`, `[last()]`,
    `[position()<n]` and `(path)[n]`. Anything outside the language is an error, not an empty match. Adapted from
    deveco-cli (MIT).
  - `--window <id>` on `dump layout`, `input`, `wait` and `screenshot` restricts dumping, selection and the screenshot
    to one window. The layout is still dumped whole, so overlays from other windows still mark elements covered.
  - `dump windows` lists every window from `hidumper -s WindowManagerService` (id, name, pid, type, z-order,
    rectangle, focus); `--json` for JSON.
  - `dump layout --flat` window headers now carry the window id (`[window 92 com.example.app]`), and two windows of the
    same bundle get a header each. The JSON tree carries `windowId` on each window's root and `hidden` on components
    with `visible: false`; a structural container kept for its id or click handler keeps its type (`Column`, `Row`, …).
  - Core exports `parseSelector`, `matchSelector`, `selectorFor` (the most specific stable selector for a recorded
    element, for record/replay), `formatSelector`, `parseXPath`, `evaluateXPath`, `findVisibleMatch`,
    `selectableTree`, `listLayoutWindows`, `windowSubtree`, `rawWindowSubtree`, `listWindows` and `parseWindowList`.
    `pickTarget`, `findLayoutNodes`, `locateTarget`, `performInput` and `waitForTarget` accept a parsed selector
    (`ElementQuery`), and `dumpLayout`, `locateTarget`, `performInput` and `waitForTarget` take `windowId`.

- f85e396: Features:

  - New `serve mcp`: a Model Context Protocol server on stdio (newline-delimited JSON-RPC 2.0; `initialize` with
    protocol version negotiation from 2024-11-05 to 2025-11-25, `ping`, `tools/list`, `tools/call`) that exposes the
    gate commands as typed tools for other agents: `build`, `check_arkts`, `test`, `apply`, `launch` (with the smoke
    check), `dump_layout` (with `flat`, `summary` and `diff`), `input`, `screenshot` (an `image/jpeg` content block
    downscaled to `maxDim`, with `grid`, `crop`, `target*`, `contactSheet` and `diff`), `wait`, `logs_crash`, and the
    read-only `screens`, `api_search`, `api_show`, `doctor` and `devices`. Each tool calls the core function its
    command uses and returns the command's `--json` object as `structuredContent` and as JSON text; the input schemas
    are the command's flags with the same defaults and help text.
  - A tool result has `isError: true` when the command would exit non-zero or could not run (bad arguments included),
    never a JSON-RPC error; stdout carries only the protocol and logs go to stderr.
  - `--project` and `--device` set the defaults every call uses, `--tools <list>` restricts the exposed set and
    `--read-only` leaves out the tools that change the device (`apply`, `launch`, `input`, `test`). Register it with
    `claude mcp add oniro-app -- oniro-app serve mcp --project <dir>`.
  - No new dependency: the protocol is a small hand-written JSON-RPC layer.

- 2a77371: Features:

  - `oniro-app test` builds a module's main and `ohosTest` HAPs, installs both, runs the suite with `aa test` and
    prints one line per case, with the message and the test-file location of a failure. It exits 0 when every case
    passed, 1 when one failed or threw, and 2 when the run did not complete (build failed, HAP missing, test module not
    found, no case ran, timeout, no device). `--json` prints the cases (with the runner's raw status code), the summary,
    the runner's result code, the app's hilog lines during the run, and a failed build's diagnostics. `--class`,
    `--timeout`, `--run-timeout`, `--no-build`, `--module`, `--product` and `--device` select what runs where.
  - Before the run the screen is turned on, a lock screen without a credential is swiped away, and the screen is kept on
    until the run ends (`--no-wake` leaves it alone).
  - Core exports `runTests`, `parseTestOutput`, `aaTestCommand`, `testHapPath`, `readTestModuleName`,
    `decideOutcome`, `isTestHap`, `wakeAndUnlock`, `holdScreenOn`, `parsePowerState` and `isLockScreenShown`.

  Fixes:

  - `discoverHaps` grouped a module's test HAP (`entry-ohosTest-signed.hap`) with its own HAPs and, the test HAP being
    newer, `app apply` and `pickHap` chose it over the app. Test HAPs are now left out.

### Patch Changes

- 8d6a262: Fixes:

  - `build` no longer silently ships an OpenHarmony-signed HAP for a HarmonyOS product (#19). When the product's
    `runtimeOS` is HarmonyOS and its signingConfig lacks `type: "HarmonyOS"` (the material a plain `sign` writes), the
    build still passes but warns on stderr, and `build --json` adds a `signing` warning diagnostic naming
    `oniro-app sign --harmonyos`. The mirror case, HarmonyOS material on an OpenHarmony product, warns too.
  - Core exports `signingMismatch`; `DiagnosticSource` gains `signing`.

- 449bbe3: Fixes:

  - `cmdtools install` no longer leaves the install directory half-written when it fails part-way (a full disk,
    say) (#16). The extracted tools are staged inside the install directory and swapped in only once complete; a
    failure before the swap leaves the existing tools untouched, one during it rolls them back, and a failed first
    install leaves no directory behind. A successful install replaces the tools' own entries (`bin`, `sdk`, `hvigor`,
    `tool`, … and whatever the archive brings) outright, whatever an earlier attempt or an older version left there;
    anything else in the directory is not the tools' and stays. If the rollback itself fails, the previous tools are
    kept in a directory the error names, never deleted.

- 9a9b5f9: Fixes:

  - `oniro-app --help` piped into another program (`oniro-app --help | less`) is no longer cut off at 8 KB on macOS.
    Help, `--version` and usage errors now exit once their output has been written, and so do errors.

- 12d51e2: Fixes:

  - The `ohosTest` module of every template declared `deviceTypes: ["phone"]`, which the OpenHarmony SDK has no
    system-capability set for, so the test HAP of a scaffolded app failed at `SyscapTransform` with `00303060
Configuration Error`. It now mirrors the main module (`default`).
  - The templates' tests exercise the template's own code: `EmptyAbility` and `HarmonyOSApp` start `EntryAbility` and
    drive `pages/Index` with UiTest (tap the greeting, expect `Welcome`), and `NativeCpp` calls the native `add` through
    `libentry.so`.

- Updated dependencies [4379401]
- Updated dependencies [97dd96c]
- Updated dependencies [96cdcc0]
- Updated dependencies [a8fac5f]
- Updated dependencies [49e3592]
- Updated dependencies [8d6a262]
- Updated dependencies [dbc01e0]
- Updated dependencies [2c05d4c]
- Updated dependencies [449bbe3]
- Updated dependencies [9a2d6c6]
- Updated dependencies [d860755]
- Updated dependencies [1ab2486]
- Updated dependencies [9d90668]
- Updated dependencies [1872e01]
- Updated dependencies [f13edd8]
- Updated dependencies [8997e6e]
- Updated dependencies [ff5bb28]
- Updated dependencies [8a6f692]
- Updated dependencies [2a77371]
  - @oniroproject/core@0.17.0

## 0.17.0

### Minor Changes

- 1f1fbc6: Features:

  - `sign --hap <file>` signs a prebuilt HAP with no project, with the SDK's development certificate and a profile for
    the bundle name in the HAP's `module.json`. `--apl`, `--app-feature`, `--acls` and `--app-privilege-capabilities`
    apply as for a project. It uses the SDK that the HAP's `targetAPIVersion` names, else the newest installed, and
    refuses a HAP built for HarmonyOS.
  - `sign --harmonyos --hap <file>` does the same for HarmonyOS, with a certificate and debug profile from AppGallery
    Connect. The ACL permissions are read from the HAP too, and a HAP built for OpenHarmony is refused. The material is
    kept per bundle name and reused while it is still valid.
  - Either way, a HAP that is already signed has its signature replaced. The signed copy is written next to the input
    (`<name>-unsigned.hap` → `<name>-signed.hap`, `<name>-signed.hap` → `<name>-resigned.hap`), or to `--out <file>`,
    which may be the input itself. A flag of the other signing mode is refused instead of being ignored.
  - Core exports `signOpenHarmonyHap`, `harmonyOsSignHap`, `readHapSigningInfo` and `defaultSignedHapPath`.

  Fixes:

  - `app apply <file.hap>` reads the bundle name out of a signed HAP, instead of failing with `Could not read the bundle
name` and asking for `--bundle`, and its asset diff works on signed HAPs. node-stream-zip could not open any HAP signed by hap-sign-tool (`Entries read error`): its read window never
    grows past a default sized to about a thousandth of the file, too small for the ~4 KB of alignment hap-sign-tool
    pads each central-directory record with.

### Patch Changes

- Updated dependencies [1f1fbc6]
  - @oniroproject/core@0.16.0

## 0.16.1

### Patch Changes

- 63f7b2e: Fixes:

  - `sign --harmonyos` no longer says `No device is connected` when a device is connected but could not be registered.
    Each attached device it cannot use gets a warning that says why (unauthorized, offline, no UDID reported, or no
    answer), and the summary then reads `No connected device could be registered`. The error for a team with no
    registered device no longer claims that nothing is connected, and says what to do.
  - `sign --harmonyos` reads a device whose status hdc does not report, as the other device commands do, instead of
    skipping it silently. Core exports `isUsableDevice`.
  - The `--harmonyos` help and the README say that a connected device is registered only if it reports a UDID.

- Updated dependencies [63f7b2e]
  - @oniroproject/core@0.15.1

## 0.16.0

### Minor Changes

- 2712058: `app apply` no longer installs another app's HAP.

  Changed:

  - `app apply` refuses a HAP whose bundleName differs from the bundle being applied, before it touches the device. It
    also accepts a `.hap` file as the positional argument, as `app install` does, and then takes the bundle name from
    the HAP (falling back from a missing `*-signed.hap` to its unsigned sibling, as installs do). Giving a HAP both
    that way and with `--hap` is an error. Core exports `readHapBundleName`.

  Fixes:

  - `discoverHaps` (used by `app install` and `app apply`) skips another app project nested inside the project (a
    subdirectory with its own `AppScope/app.json5`), whose newer HAP used to win and replace the wrong app.

- 20049a3: Install an OpenHarmony SDK from a local archive, which is how the full SDK gets installed.

  - `sdk install --from-archive <path>` installs a local SDK `.tar.gz`, such as an `ohos-sdk-full` archive from the
    OpenHarmony daily builds (https://dcp.openharmony.cn/workbench/cicd/dailybuild/dailylist), which the release mirror
    does not carry. Only the current OS's components are unpacked, wherever they sit in the archive, and the API level
    is read from their `oh-uni-package.json`. An SDK already installed at that level is replaced only with `--force`.
    `sdk install --help`, and `sdk install` with neither a version nor an archive, point at the daily builds.
  - The system-API build hint (`'…' is not exported from Kit '…'`) now names the daily builds and
    `sdk install --from-archive` instead of describing a manual unpack.
  - Core exports `installSdkFromArchive`, `findSdkOsDir`, `readZipEntry` and `OHOS_DAILY_BUILDS_URL`;
    `extractTarball` takes an optional entry filter.

- a7cfe1f: `wait --log` and `watch --log` only match lines logged after the command starts.

  Changed:

  - `hdc shell hilog` replays the buffer before it streams, so `wait --log` and `watch --log` used to return lines from
    minutes or hours ago (a previous run's `complete: done`, a 95 s old `status=503`), which answered "did X fire?"
    wrongly. They now skip lines logged before the command started, measured on the device clock. `--since <seconds>`
    also accepts lines up to N seconds before the command (useful right after a tap), and `--since all` restores the
    old behaviour; `--since` without `--log` is an error. When the device clock can't be read, every line can match and a
    warning says so. A `wait --log` that spans a reboot which resets the device clock (a board without an RTC) still
    matches the lines logged after it. `wait --log` prints the matched line's device time.
  - In core, `waitForLog` and `watchLog` take a `lookbackMs` option (default 0, `Infinity` for the whole buffer), and
    `hilogTimeMs` is exported.

### Patch Changes

- 3770e90: Fixes:

  - `lint` no longer prints `No defects found.` when codelinter exited non-zero without a report. It says nothing was
    linted, and names the project-root files the directory lacks (`build-profile.json5`, `hvigorfile.ts` or `.js`,
    `hvigor/hvigor-config.json5`). Core exports `missingProjectRootFiles`.

- Updated dependencies [2712058]
- Updated dependencies [3770e90]
- Updated dependencies [20049a3]
- Updated dependencies [a7cfe1f]
  - @oniroproject/core@0.15.0

## 0.15.0

### Minor Changes

- ccbea89: Add `logs collect`, which packages a device's logs and diagnostic snapshots into one bundle.

  New:

  - `logs collect [--device s] [--package b] [--pid p] [--tag t] [--level l] [--duration s] [--redact] [-o dir]
[--json]` captures the hilog buffer (`hilog -x`), faultlog entries (`hidumper -e`, scoped to `--package`), the
    device name, the process list, and memory and thread snapshots into a timestamped `incident-…` directory, with a
    `manifest.json` recording each command's result, and zips it. `--duration` (default 600 s) keeps the hilog
    records from that window, measured against the device clock. `--pid`, `--tag` and `--level` add a filtered hilog
    view. With `--redact`, the ZIP is built only from a redacted copy, and redaction fails closed on binary or
    non-UTF-8 files. A partial bundle exits 1. `logs -o <file>` still captures a whole session.

  Fixes:

  - `parseDeviceList` reports a UART endpoint that hdc lists as `Ready` with that status instead of `Unknown`, so
    `selectDevice` no longer counts it as a connected device (`Multiple devices connected (COM3, …)`).
  - `runProcess` decodes stdout and stderr as streams, so a multi-byte UTF-8 character split across two chunks is no
    longer turned into replacement characters.

### Patch Changes

- Updated dependencies [ccbea89]
  - @oniroproject/core@0.14.1

## 0.14.0

### Minor Changes

- bb57ec8: Fix device targeting, catch failures hdc reports as success, and fill gaps found while evaluating a batch of apps on two targets.

  Fixes:

  - `ONIRO_DEVICE_SERIAL` (and `DEVICE_SERIAL`) is now honoured by every device command. Before, nothing read it,
    so with two targets connected `screenshot`, `dump layout`, `app launch` and `app apply` failed with
    `need connect-key`, including for a TCP serial such as `127.0.0.1:5555`. `--device` still wins. hdc server
    commands (`list targets`, `tconn`, `start`, `kill`) are never addressed from the env var. The streams that
    spawned hdc directly (`hilog`, `track-jpid`) now address the device too.
  - hdc exits 0 when it prints `[Fail]…`. Such a line now counts as a failure, and a `need connect-key` error says
    how to pick a device. `ensureOk` reports stdout when stderr is empty.
  - `app install` and `app apply` fail when the bundle manager rejects the HAP (`msg:error: failed to install
bundle`, `code:95xxxxx`), which hdc also reports with exit code 0. `app apply` then checks with `bm dump` that the
    bundle is installed before reporting success.
  - `lint` parses codelinter's real report (a `<file>(<count>)` header, then `<line>:<col> <severity> <message>
<rule>` rows, then a `-Defects: …` summary). Before, every run printed "No findings." and exited 1. It now prints
    the findings and the totals, and exits 1 only on error-severity findings or when codelinter produced no report.
    When codelinter warns that the report is incomplete, `lint` explains why on stderr: the command-line tools'
    flavour does not match the project's `runtimeOS`.
  - `build` no longer advises `sign --harmonyos` as the only option for an unsigned HarmonyOS build (the HarmonyOS
    emulator installs unsigned HAPs), and fails early, naming the release to install, when an OpenHarmony
    project's `compileSdkVersion` SDK is missing. `sign` raises the same error.
  - `sign` points a product that names no `signingConfig` at the generated one. Before, the build stayed unsigned.
  - `paramGet` throws for an unset property instead of returning `Get parameter "…" fail!` as its value.
  - `file send` / `file recv` normalise the local path. hdc read a forward-slash Windows path (`C:/Users/…`) as
    relative, and could not resolve an 8.3 short path. A device path that Git Bash already rewrote is rejected
    with a hint to set `MSYS_NO_PATHCONV=1`.

  New:

  - `devices --long`: OS family and version, API level, CPU ABI, device type, and model of each connected target.
    `getDeviceInfo` reads all of them in one round trip (`paramGetMany`), and adds `osFamily`, `osDistName`,
    `osDistVersion`, `abi`, and `deviceType`.
  - `logs -o <file> [--for ms] [--grep re] [--clear]` captures hilog for a whole session, so the small device log
    buffer can no longer drop its start. It writes each line as it arrives and reconnects after a reboot. Core:
    `captureLog`.
  - `hdc [args...]` runs the bundled hdc, addressed at `--device` / `ONIRO_DEVICE_SERIAL`; `hdc --path` prints it.
    Global options must now come before the command (`oniro-app --version`).
  - `emulator status`: installed, running, and connected, without starting the emulator. Core: `getEmulatorStatus`.
  - `cmdtools status` shows the tools' flavour (HarmonyOS or OpenHarmony) and the hdc path. Core:
    `detectCmdToolsFlavour`.
  - `app install` takes a `.hap` path as well as a project dir. With no signed HAP, `app install` and `app apply`
    fall back to the unsigned one on any target (`app install` takes the entry module's when several modules have
    one), and a `*-signed.hap` path that does not exist falls back to its `*-unsigned.hap`. When the target refuses
    the unsigned HAP, the error names the bundle manager's reason (e.g. `code 9568320: no signature file`) and the
    `sign` command to run, instead of hdc's raw output. HAPs are now newest first, so a fresh build wins over HAPs
    committed to the repository.
  - `file send --bundle <b>` writes into an app's sandbox (relative paths resolve inside it) and chowns the file to
    the app, which cannot read the root-owned files hdc creates.
  - `sign --app-privilege-capabilities <list>` writes `app-privilege-capabilities` into the profile, e.g.
    `AllowAppUsePrivilegeExtension`, without which a privileged extension ability fails to install with 9568344.
  - `build --install-sdk` installs the missing OpenHarmony SDK and builds. A build that fails on system-API errors
    (`'…' is not exported from Kit '…'`) gets a hint about the full SDK.
  - Core also exports `resolveDeviceSerial`, `hdcTargetArgs`, `hdcTargetArgsFor`, `hdcClientFailure`,
    `detectInstallFailure`, `ensureInstallOk`, `installFailureReason`, `unsignedHapRejection`, `isUnsignedHap`,
    `existingHapOrUnsigned`, `isBundleInstalled`, `pickHap`, `parseCodelinterReport`,
    `cleanCodelinterOutput`, `findMissingProjectSdk`, `diagnoseBuildFailure`, `normaliseLocalPath`,
    `assertDevicePath`, and `appSandboxDir`.

### Patch Changes

- Updated dependencies [bb57ec8]
  - @oniroproject/core@0.14.0

## 0.13.0

### Minor Changes

- 8fe78e6: Make driving the UI from an agent less error-prone.

  - `oniro-app dump layout --flat` prints one line per labelled or interactive element
    (type, label, `#id`, center as 0–1 fractions, flags), grouped by window, with the
    soft keyboard collapsed to one line. The JSON output stays the default.
  - The pruned layout now reports placeholder text (`hint`), `disabled` components, and
    `covered` elements, meaning those painted over by a later layer with a visible
    background (a dialog scrim, an overlay, the keyboard). With keyboard detection it
    also carries `keyboard: { shown, bundle, b }`.
  - `oniro-app input` can act on an element by label with `--target` (plus
    `--target-id`, `--target-type` and `--target-index`), or take a position as 0–1
    fractions with `--fx`/`--fy`/`--fx2`/`--fy2`.
    - Covered elements are skipped and clickable ones are preferred. An ambiguous match
      fails and lists the candidates.
    - When the soft keyboard hides the element, it is dismissed first.
  - New input types:
    - `clearText` clears a field with Ctrl+A then Delete.
    - `hideKeyboard` presses Back only when the keyboard is shown.
  - `inputText` gains `--clear`, and any action can take `--hide-keyboard`.
  - `--key` accepts named keys (`Delete`, `Enter`, `Tab`, `Escape`, `MoveHome`, …),
    letters, and combos of up to three keys such as `Ctrl+A`.
  - `oniro-app wait --target <text> [--gone]` waits for an element to appear or
    disappear.
  - `oniro-app screenshot --crop x1,y1,x2,y2` and `--target <text>` write a
    full-resolution crop of one region or element.
  - `oniro-app gesture --fractions` takes waypoints as 0–1 fractions.
  - Core exports `performInput`, `locateTarget`, `hideKeyboard`, `waitForTarget`,
    `flattenLayout`, `findLayoutNodes`, `pickTarget`, `findCoveredNodes`,
    `resolveKeyEvent`, and the IME helpers.

### Patch Changes

- Updated dependencies [8fe78e6]
  - @oniroproject/core@0.13.0

## 0.12.0

### Minor Changes

- 0363671: Add OpenHarmony 7.0 (API 26) to the known SDKs, so `oniro-app sdk list` shows it and
  `oniro-app sdk install 7.0` downloads it.

  The mirror re-published 7.0 under dated archive names (`…_20260829.tar.gz`); the
  undated archives hold `-Beta` components. `SdkRelease` gains an optional
  `archiveSuffix`, which `getSdkFilename` appends to the archive basename, and 7.0 uses
  it to fetch the `-Release` build.

### Patch Changes

- 838a2a5: Recover the hdc connection to a TCP device (e.g. the emulator) that wedges after a
  reboot. The hdc server can keep the old session "Connected": `hdc tconn` answers
  "Target is connected, repeat operation" and every command fails until the server is
  restarted, so `oniro-app reboot --wait-bundle` and `oniro-app wait` timed out. The
  post-reboot waits now restart the hdc server (`hdc start -r`) and reconnect when tconn
  claims a connection the device does not answer on three polls in a row.
- Updated dependencies [838a2a5]
- Updated dependencies [0363671]
  - @oniroproject/core@0.12.0

## 0.11.0

### Minor Changes

- ee2715c: Add HarmonyOS support alongside OpenHarmony.

  A project is HarmonyOS when its product declares `runtimeOS: "HarmonyOS"` in
  `build-profile.json5`, as DevEco Studio writes. Every other project is OpenHarmony
  and behaves exactly as before, offline signing included.

  - `oniro-app auth login|logout|status|team list` — sign in to a Huawei developer
    account. The token is stored encrypted under `ONIRO_HARMONYOS_AUTH_DIR`.
  - `oniro-app sign --harmonyos` — AppGallery Connect issues a debug certificate and
    profile, and the encrypted signingConfig is merged into `build-profile.json5`.
    Still-valid material is reused; `--force` regenerates. No device needs to be
    attached when the team already has devices registered. The certificate is named
    `oniro_debug_<team>.cer`, so it coexists with DevEco Studio's own.
  - `oniro-app build` builds HarmonyOS projects against the HarmonyOS SDK
    (`DEVECO_SDK_HOME`), with that install's hvigor and ohpm.
  - `oniro-app create --template HarmonyOSApp` scaffolds a HarmonyOS project.
  - The HarmonyOS SDK is found in DevEco Studio's default location, at the
    command-line-tools path when those are the HarmonyOS edition, or at
    `ONIRO_HARMONYOS_SDK_PATH`. It cannot be downloaded the way the OpenHarmony SDK
    can, so nothing is fetched.

  HarmonyOS signing calls private AppGallery Connect APIs and needs a Huawei developer
  account that is real-name verified or has accepted the HUAWEI Developer Basic
  Service Agreement. Accounts from every Huawei region work — calls go to the
  account's own region, as in DevEco Studio — whereas Huawei's own CLI accepts only
  Chinese-mainland accounts. Parts of `packages/core/src/harmonyos/` are adapted from
  the MIT-licensed `openharmony-sig/deveco-cli`; see
  `packages/core/src/harmonyos/NOTICE.md`.

### Patch Changes

- Updated dependencies [ee2715c]
  - @oniroproject/core@0.11.0

## 0.10.0

### Minor Changes

- 73a11d5: Add device targeting to app installation. `installApp` now accepts `deviceSerial`, and `oniro-app app install` exposes it as `--device <serial>`.

### Patch Changes

- Updated dependencies [73a11d5]
  - @oniroproject/core@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [67b2d62]
  - @oniroproject/core@0.9.0

## 0.9.0

### Minor Changes

- 78de405: Keep install temporaries off `/tmp`, and explain it when they run out of room.

  `sdk install`, `cmdtools install`, and `emulator install` downloaded a multi-GB archive and
  extracted it in a scratch directory under the system temp dir. On most Linux systems `/tmp` is a
  RAM-backed `tmpfs` sized from available memory, so machines with plenty of disk but little free
  RAM could not install the SDK or the command-line tools at all.

  - **The scratch directory now lives next to the install target** — `.oniro-tmp` beside the SDK
    root, the command-line-tools directory, or the emulator directory. That keeps a RAM-backed
    system temp dir out of the picture, and since temporaries and their destination now share a
    filesystem, finishing an install is a rename instead of a multi-GB cross-device copy. When the
    install target's parent cannot be written to (a root-owned prefix, a read-only mount), the
    system temp dir is used instead and a warning says so.
  - **`--tmp-dir <path>` on all three install commands**, plus the `ONIRO_TMP_DIR` environment
    variable (`tmpDir` config key). Precedence: flag → env → `<install root>/.oniro-tmp`. A
    directory named explicitly is never swapped out silently.
  - **Fail before downloading** when the advertised `content-length` does not fit in the scratch
    directory's free space, so nothing is written when it cannot fit.
  - **Clear errors instead of a crash.** A write failure during the download had no handler, so an
    out-of-space filesystem surfaced as an unhandled `ENOSPC` event that killed the process.
    Out-of-space failures anywhere in an install now raise `InsufficientSpaceError`, naming the
    directory, how much room was needed versus available, whether that directory is RAM-backed
    (`tmpfs`), and the `--tmp-dir` / `ONIRO_TMP_DIR` remedy.

  New in `@oniroproject/core`: `InsufficientSpaceError` and the temp-space helpers in `sdk/tmp.ts`
  (`createInstallTempDir`, `removeTempWorkDir`, `resolveTmpRoot`, `createTempWorkDir`,
  `getFreeSpaceBytes`, `isRamBackedPath`, `ensureFreeSpace`, `isOutOfSpaceError`, `toSpaceError`,
  `formatBytes`, `INSTALL_TMP_DIRNAME`, `TMP_DIR_HINT`). `downloadFile` gains `what` and `tmpRoot`
  options; the three install option objects gain `tmpDir`. Downstream frontends need no changes —
  the new `tmpDir` config key is optional, and a `ConfigProvider` that does not know it just returns
  the fallback.

### Patch Changes

- Updated dependencies [78de405]
  - @oniroproject/core@0.8.0

## 0.8.1

### Patch Changes

- b307540: Two `app apply` / device-process fixes, both surfaced while deploying an app whose code
  runs in an **extension-ability** process:

  - **`app apply`: make `--bundle` optional.** When omitted it now auto-resolves the bundle
    name from the project's `AppScope/app.json5`, matching how `app launch` and `build`
    already discover the bundle/ability. Previously `--bundle` was required, inconsistent with
    the rest of the device commands.

  - **Detect extension-ability processes when checking "is the bundle running".**
    `findRunningProcess` matched only the bundle's main (UIAbility) process via
    `pidof '<bundle>'`. Apps whose only live process is an extension ability — ServiceExtension,
    FormExtension, UIExtension, input method, etc. — run under a separate process name
    `"<bundle>:<ext>"` and were reported as not running (so `app apply` printed `pid - -> -`
    and the wait/log helpers couldn't find them). It now falls back to `track-jpid` and matches
    `"<bundle>"`, `"<bundle>/…"`, or `"<bundle>:…"`. This makes the apply pre/post-pid check,
    `wait --bundle`, and hilog pid filtering work for extension-hosted apps.

## 0.8.0

### Minor Changes

- e9e80fe: Add a `NativeCpp` project template — an ArkTS + Native C++ (N-API) starter with a CMake-built native library. Selectable via `oniro-app create --template NativeCpp` and listed by `oniro-app templates list`.

## 0.7.0

### Minor Changes

- 189b878: Expose the new core device/build/install/signing surface as CLI subcommands.

  New commands: `reboot`, `wait` (`--log`/`--boot`/`--bundle`), `watch --log`, `screenshot [--burst]`, `dump [layout]`, `devices`, `file send`/`file recv`, `lint`, `input`, and `gesture`. The `app` command gains `apply` (verified install with sign-info/asset-cache/restart handling), `uninstall`, and `stop`, and `app launch` gains `--ability`. `sign` gains `--bootstrap` (no-op when signing material is present, else generate) plus `--store-password`/`--key-password`.

  `build` now runs the `buildHap` orchestrator (auto `ohpm install --all` when `oh_modules/` is missing, then build, then HAP discovery) and **builds in parallel by default** — pass `--no-parallel` to restore serial builds, `--no-deps` to skip the ohpm step, and `--json` to emit the discovered HAPs.

  Read/observe commands (`devices`, `dump`, `wait --log`, `watch`, `lint`, `app apply`) support `--json` on stdout; logs/progress stay on stderr. Requires `@oniroproject/core@^0.7.0`.

- 3e728db: `oniro-app screenshot` now does the agent-facing image processing itself (moved out of the ohos-hdc MCP).

  - **`--grid`** downscales to `--max-dim` (longest side, default 1024) and overlays a 10x10 grid with 0.0–1.0 axis labels for picking tap coordinates — equivalent to the old MCP `screenshot`. `--max-dim` on its own downscales without the grid.
  - **`--contact-sheet`** captures a burst (default 8 frames at `--interval`; pass `--burst N` to change the count) and composites it into a single tiled image with per-frame index labels, writing **per-frame change diffs (0..1)** to stdout (`--json` for the full object) so you can spot the frame where something changed. One image replaces N — a large token saving when verifying transient UI (gestures, animations, boot).

  A plain `oniro-app screenshot` still writes the full-resolution raw JPEG (unchanged). Adds `sharp` as a CLI dependency (kept external in the tsup build); `@oniroproject/core` stays image-dependency-free.

### Patch Changes

- Updated dependencies [29958f8]
- Updated dependencies [16114d8]
- Updated dependencies [03f0a89]
- Updated dependencies [e4c328a]
- Updated dependencies [a54a857]
- Updated dependencies [e117386]
- Updated dependencies [e4c328a]
- Updated dependencies [eb63f30]
- Updated dependencies [ac9fa01]
- Updated dependencies [b89b46f]
- Updated dependencies [637fff5]
  - @oniroproject/core@0.7.0

## 0.6.2

### Patch Changes

- Fix signing of apps that request privileged (system_basic/system_core) permissions.

  - Route system*basic/system_core through the OpenHarmony **Application Release** key/cert chain (BMS rejects HAPs signed with the SDK's \_Profile* Release cert once an apl-elevated permission is requested).
  - New `--acls <list>` flag on `oniro-app sign` to populate the profile's `acls.allowed-acls`; omitting it leaves the existing template value untouched (`apl=normal` default unchanged).
  - `updateBuildProfile()` now preserves per-product `signingConfig` names from `build-profile.json5` instead of forcing `"default"`, so system-app source trees (e.g. `systemui` using `signingConfig: "release"`) work without manual renaming.

- Updated dependencies
  - @oniroproject/core@0.6.2

## 0.6.1

### Patch Changes

- a7a4437: Add a package README so each npm landing page shows install and usage info instead of "no readme data". No code changes.
- Updated dependencies [a7a4437]
  - @oniroproject/core@0.6.1

## 0.6.0

### Minor Changes

- 9ed025e: First npm release of the rewritten cross-platform Node monorepo.

  - Replaces the `.deb`-only bash CLI with `@oniroproject/core` (library) and `@oniroproject/oniro-app` (CLI), runnable on Linux, macOS, and Windows.
  - Adds emulator launcher + reusable CI workflow, hilog streaming with buffer-level + line parser, and `--apl/--app-feature` flags for signing system-permission apps.

### Patch Changes

- Updated dependencies [9ed025e]
  - @oniroproject/core@0.6.0
