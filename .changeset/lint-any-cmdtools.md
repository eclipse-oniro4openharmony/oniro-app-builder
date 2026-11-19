---
'@oniroproject/core': patch
'@oniroproject/oniro-app': patch
---

`lint` now fully checks a project with any command-line tools, whichever SDK they bundle. It
used to run the tools' `bin/codelinter` launcher, which always passes the tools' own SDK, so
with the HarmonyOS command-line tools (including the default `cmdtools install` download)
codelinter refused an OpenHarmony project ("The type of command line tools does not match that
of the project"), skipped its checks, and `lint` exited 2.

- `runCodelinter` runs `codelinter/index.js` under the tools' Node.js, with the SDK argument
  the project's `runtimeOS` needs: `ohosSdkPath` for OpenHarmony (codelinter then reads the
  OpenHarmony SDK from `local.properties` `sdk.dir`); for HarmonyOS, the tools' own SDK when it
  is the HarmonyOS one, as their launcher passes it, else the HarmonyOS SDK a build uses (and
  the no-HarmonyOS-SDK error when there is none). Verified with command-line tools 5.1.0.840
  (codelinter 5.1.140) and 6.1.1.280 (codelinter 6.0.240) on an OpenHarmony and a HarmonyOS
  project.
- For an OpenHarmony project whose `local.properties` does not name an SDK holding its
  `compileSdkVersion`, `lint` sets `sdk.dir` to the SDK `sdk install` installed for the run
  and restores the file afterwards, also on Ctrl+C (`lint` then exits 130); when that SDK is
  not installed, it fails with the `sdk install` command to run.
- `--files` glob patterns are expanded against the project (Node.js 22 or newer), as the
  launcher's shell did. A file codelinter cannot find makes the report incomplete (exit 2), or
  the run fail when no file is left, instead of a clean report.
- Core: `codelinterInvocation(config, projectDir, files?, logger?)` returns what
  `runCodelinter` runs. `CODELINTER_OHOS_SDK_ARG` and `expandCodelinterFiles` are exported.
- `lint` exits 1, not codelinter's own code, when codelinter produced no report.
- `doctor` no longer has the `cmdtools-flavour` check, and core no longer exports
  `checkCmdToolsFlavour`: the tools' flavour no longer matters to `lint`.
