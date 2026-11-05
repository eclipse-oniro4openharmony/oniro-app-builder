---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

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
