# @oniroproject/core

Shared library powering the Oniro/OpenHarmony app-development toolchain. Wraps SDK install, command-line tools install, project scaffolding, signing-config generation, `hvigorw` builds, emulator lifecycle, `hdc` install/launch, and hilog streaming — all behind a vscode-agnostic API that runs on Linux, macOS, and Windows.

This package backs [`@oniroproject/oniro-app`](https://www.npmjs.com/package/@oniroproject/oniro-app) (the `oniro-app` CLI). If you just want to build/run Oniro apps from a shell, install the CLI; install this library directly if you're embedding the same functionality into an editor extension or another tool.

## Install

```bash
npm install @oniroproject/core
```

Requires Node.js 20+.

## Usage

```ts
import { installSdk, signProject, buildProject } from '@oniroproject/core';
```

The exported surface mirrors what the CLI exposes — SDK/cmd-tools/emulator install + lifecycle, project create, sign, build, hdc install/launch, hilog parsing. See the [repository README](https://github.com/eclipse-oniro4openharmony/oniro-app-builder#readme) for the high-level workflow.

## License

Apache-2.0
