---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

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
