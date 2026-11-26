---
'@oniroproject/core': patch
'@oniroproject/oniro-app': patch
---

Projects for API 26 (OpenHarmony 7.0, HarmonyOS 26.0.0) build with the 26.0.0 command-line
tools (hvigor 6.26). From API 26, hvigor names an SDK by its dotted release rather than its API
level, which broke oniro-app in five places. Verified with command-line tools 26.0.0.821 (hvigor
6.26.4): `create --sdk 26` projects from the OpenHarmony and HarmonyOS templates build and pass
`check arkts` unedited, and an existing API 26 project with its SDK in `linux/26` had the folder
moved by `build`, then ran on the HarmonyOS 7.0 emulator. An API 23 project still builds with
those tools and with 6.1.1.280.

- `sdk install` puts an API 26+ SDK in `<os>/<release>` (`linux/26.0.0`), where hvigor 6.26
  looks for it; in `linux/26` the build failed with `00308018 The SDK management mode has
  changed`. Lookups (`build`, `check arkts`, `lint`, `sign`, `api`, `doctor`, `sdk list`,
  `sdk remove`) read both folders. `build` moves an SDK an older oniro-app installed in
  `linux/26` to `linux/26.0.0` before it runs hvigor. `sdk install` and `doctor --fix` move it
  too, and `doctor` reports it as an `sdk` failure until it is moved. A symlinked `26.0.0`
  folder, which hvigor 6.26 does not follow, does not count as installed; a link to `26/` is
  replaced by the move. `sdk remove 26.0.0` removes only that release, and `sdk install
  --from-archive` installs another API 26 release beside the installed one without `--force`.
- An OpenHarmony project of API 26 or later whose command-line tools ship hvigor older than 6.26
  (5.1.0, the default download, and 6.1.1) fails before hvigor runs. The error names the hvigor
  it needs and how to install the newer tools (`cmdtools install --from-zip`). `doctor`'s
  `cmdtools` check fails the same way, and `sdk install` warns after installing an API 26 SDK.
- `create --sdk 26` writes `compileSdkVersion` and `compatibleSdkVersion` as the release string
  (`"26.0.0"`, or the installed SDK's release) instead of the number, which hvigor 6.26 rejects.
  For an OpenHarmony template it also sets `modelVersion` to `6.0.0` in
  `hvigor/hvigor-config.json5` and `oh-package.json5`; without it the build fails with
  `00303315`.
- `check arkts`, `doctor`, `lint`, `sign` and the `api` commands accept a dotted
  `compileSdkVersion` (`"26.0.0"`). Before, they required a number and said the project
  declared no numeric `compileSdkVersion`.
- A HarmonyOS project's SDK label is `"26.0.0"` from API 26, not `"26.0.0(26)"`, which
  hvigor 6.26 misreads as release 6.0.0 (`00303313`). This applies to `create --template
  HarmonyOSApp` and to the `version` of the HarmonyOS SDK in `sdk list --json` and build reports.
  `HARMONYOS_SDK_VERSIONS` adds API 22 (`6.0.2`), 23 (`6.1.0`) and 26 (`26.0.0`).
- Core: new `sdk/apiVersion` helpers: `ohosSdkVersionValue`, `apiOfDottedVersion`,
  `usesDottedVersion`, `compareDottedVersions` and `FIRST_DOTTED_API`. New `sdk/apiDir` helpers:
  `listSdkApiDirs`, `findSdkApiDir`, `expectedSdkApiDir`, `migrateLegacySdkApiDir`,
  `legacySdkApiDirTarget`, `sdkApiDirName`, `apiOfSdkDirName` and `readOhUniPackage`. Also new: `detectProjectSdk`,
  `findProjectSdkDir`, `migrateProjectSdkDir`, `findHvigorTooOld`, `harmonyOsSdkLabel` and
  `apiOfHarmonyOsSdkLabel`. `checkCmdTools` takes the project as an optional third argument.
