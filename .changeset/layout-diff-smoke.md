---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

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
