# Third-party attribution — faultlog analysis

Parts of this directory are **adapted from
[`openharmony-sig/deveco-cli`](https://gitcode.com/openharmony-sig/deveco-cli)**
(`packages/cli/src/faultlog/`, version 1.3.10), Copyright (c) 2026 Huawei Device
Co., Ltd., licensed under the **MIT License**.

The rest of `@oniroproject/core` is Apache-2.0. MIT is compatible with Apache-2.0,
so the combined work ships under Apache-2.0 with this notice preserved; the MIT
copyright and permission notice is reproduced in full at the bottom of this file
and in the repository-root `NOTICE`.

## Which files are adapted

Each adapted file carries a header naming the upstream file it came from.

| This package | Upstream (`packages/cli/src/faultlog/`) |
| --- | --- |
| `classify.ts` | `identify/classify.ts`, `identify/identify-faultlog.ts`, `types.ts` |
| `text.ts` | `crash/log-text.ts`, `crash/hilog-section.ts` |
| `frames.ts` | `crash/stack-parser.ts` |
| `binder.ts` | `crash/binder-chain.ts` |
| `parsers.ts` | `crash/cppcrash-parser.ts`, `crash/jserror-parser.ts`, `crash/freeze-parser.ts` |
| `verdict.ts` | `crash/crash-analyzer.ts` |

Written for this package: `crashJson.ts` (faultloggerd's crash records),
`device.ts` (listing and fetching from a device). Upstream reads local files
only.

Not ported: `sample-stack/sample-stack-analyzer.ts` (sample-stack hotspot
statistics; this package classifies a sample stack but does not analyse it),
`crash/faultlog-collector.ts` (directory scan; `device.ts` lists the device
instead), the Chinese text report renderer, the memory-corruption heuristic,
and the telemetry error codes.

## Notable deviations from upstream

- **ArkTS frames as devices print them.** Upstream's frame patterns expect
  `at f (file:line:col)`; OpenHarmony 7.0 prints the module after the function,
  `at parseConfig entry (entry/src/main/ets/pages/Index.ets:8:13)`. Upstream
  therefore finds no frames in a real jscrash and rates it on its header alone.
  Both forms are read here.
- **More freeze events.** `SERVICE_BLOCK`, `SERVICE_WARNING`, `SERVICE_TIMEOUT`,
  `THREAD_BLOCK_3S` and `BUSSINESS_THREAD_BLOCK_*` are recognised as well as
  upstream's `THREAD_BLOCK_6S`, `APP_INPUT_BLOCK` and `LIFECYCLE_TIMEOUT`.
- **One verdict shape.** Upstream's `key-report` (Chinese keys, raw frame
  strings) is replaced by `CrashVerdict`: parsed native and ArkTS frames, the
  first frame in the project's own code with its `file`, `line` and `column`,
  the JS error, and the binder chain as labelled edges.
- English evidence and messages; `OniroError` instead of upstream's
  `FaultLogError` codes.

## MIT License

```
MIT License

Copyright (c) 2026 Huawei Device Co., Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
