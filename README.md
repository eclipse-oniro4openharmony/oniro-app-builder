# Oniro App Builder

Cross-platform tooling for **Oniro / OpenHarmony** app development. This monorepo ships two npm packages:

| Package | What it is | Docs |
| --- | --- | --- |
| [`@oniroproject/core`](packages/core) | A vscode-agnostic library wrapping SDK install, build, sign, emulator lifecycle, and the full `hdc` device surface. | [**API reference →**](packages/core/README.md) |
| [`@oniroproject/oniro-app`](packages/cli) | The `oniro-app` CLI built on the core. Non-interactive: explicit flags, results on stdout, logs on stderr, exit codes reflect success. | [**Command reference →**](packages/cli/README.md) |

The CLI runs on Linux, macOS, and Windows. Everything in the OpenHarmony inner loop — SDK install → scaffold → sign → build → install on device → launch, plus screenshot / UI-layout dump / input / hilog for driving a running app — can be scripted from `oniro-app`. Nothing in this repo touches firmware or device images.

## Install

Requires Node.js 20+ (and a JDK on `PATH` for `oniro-app sign`).

```bash
npm install -g @oniroproject/oniro-app
oniro-app --help
```

## Typical workflow

```bash
oniro-app sdk install 6.1
oniro-app cmdtools install
oniro-app create --name HelloOniro --bundle com.example.hello \
                 --location ~/projects --sdk 23
cd ~/projects/HelloOniro
oniro-app sign
oniro-app build
oniro-app emulator install
oniro-app emulator start --wait-for-hdc 300
oniro-app app install
oniro-app app launch
```

The full command list, environment-variable configuration, and the system-permission signing guide live in the **[CLI README](packages/cli/README.md)**. To call the same functionality from your own code, see the **[core API reference](packages/core/README.md)**.

## Docker

The repo ships a Dockerfile that produces a self-contained image with the CLI + SDK + command-line tools pre-installed:

```bash
docker build --build-arg ONIRO_SDK_VERSION=6.1 -t oniro-app .
docker run --rm -v $(pwd):/workspace oniro-app build     # or sign / sdk list / app install ...
```

The image bakes the SDK and tools into `/opt/oniro/` and exports `ONIRO_SDK_ROOT_DIR` / `ONIRO_CMD_TOOLS_PATH` to point at them — overridable at `docker run` time via `-e`. Drop into a shell with `--entrypoint bash` to inspect the environment.

## Repo layout

```
packages/
├── core/   # @oniroproject/core — shared library (no vscode deps)
└── cli/     # @oniroproject/oniro-app — the oniro-app binary, ships templates/
Dockerfile   # container image: node:20-slim + JDK + oniro-app + SDK preinstall
.github/workflows/
├── ci.yml              # cross-OS matrix: typecheck/build/test + docker build
├── scaffold-app.yml    # reusable: `oniro-app create` → upload project artifact
├── build-app.yml       # reusable: download project → sign + build → upload signed .hap
├── emulator-run.yml    # reusable: download .hap → install/launch/drive in QEMU → screenshot
├── test-sample-app.yml # orchestrator: chains the three reusable workflows on push/PR
└── release.yml         # changesets versioning + npm publish
```

## Development

```bash
npm install
npm run build       # builds both packages
npm test            # runs vitest suites
npm run typecheck
```

Exercise the CLI during development with `node packages/cli/dist/oniro-app.js <subcommand>`, or globally via `npm install -g ./packages/cli` after the first build.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs the inner loop (typecheck, build, unit tests) on Linux, macOS, and Windows for every push and PR — the cross-platform contract is enforced there.

End-to-end CI is split into three composable reusable workflows chained by [`test-sample-app.yml`](.github/workflows/test-sample-app.yml): **scaffold** (`oniro-app create`) → **build** (sign + build the `.hap`) → **emulator-run** (install, launch, and exercise the full on-device command surface in a headless QEMU emulator, capturing a screenshot and UI dump). Each stage exercises one logical concern, so a failure points at one CLI command rather than a monolithic job.

## Contribution

Pull requests and issues welcome.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
