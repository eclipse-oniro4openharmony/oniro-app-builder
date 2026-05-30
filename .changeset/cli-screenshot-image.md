---
"@oniroproject/oniro-app": minor
---

`oniro-app screenshot` now does the agent-facing image processing itself (moved out of the ohos-hdc MCP).

- **`--grid`** downscales to `--max-dim` (longest side, default 1024) and overlays a 10x10 grid with 0.0–1.0 axis labels for picking tap coordinates — equivalent to the old MCP `screenshot`. `--max-dim` on its own downscales without the grid.
- **`--contact-sheet`** captures a burst (default 8 frames at `--interval`; pass `--burst N` to change the count) and composites it into a single tiled image with per-frame index labels, writing **per-frame change diffs (0..1)** to stdout (`--json` for the full object) so you can spot the frame where something changed. One image replaces N — a large token saving when verifying transient UI (gestures, animations, boot).

A plain `oniro-app screenshot` still writes the full-resolution raw JPEG (unchanged). Adds `sharp` as a CLI dependency (kept external in the tsup build); `@oniroproject/core` stays image-dependency-free.
