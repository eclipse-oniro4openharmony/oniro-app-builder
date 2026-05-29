---
"@oniroproject/core": minor
---

Add rich-capture primitives: screenshots, input injection, and layout dump.

- **`hdc/display.ts`**: `getDisplaySize()` — device render resolution from `hidumper -s 10 -a screen` (the W/H source; no image decoding).
- **`hdc/screen.ts`**: `takeScreenshot()` returns raw JPEG `{ pixels, width, height }` via `snapshot_display` + `file recv`; `captureBurst()` returns raw frame buffers from a single device-side capture loop. The grid overlay / downscale / base64 stay in the MCP — **core adds no image dependency**.
- **`hdc/input.ts`**: `sendInput()` (pixel-space `uitest uiInput`; the %→px step stays in the MCP), `sendGesture()` (chained `uitest uiInput drag` segments, routing to the raw-touch path when holds are requested), and `sendRawTouch()` (`uinput -T` — the press-time escape hatch; doc-comment warns the `-g` form silently no-ops under 500ms press/total windows). Command construction is factored into pure, tested builders (`buildInputCommand` / `buildGestureCommands` / `buildRawTouchCommand`).
- **`hdc/dump.ts`**: `dumpLayout()` runs `uitest dumpLayout`, pulls the JSON, and returns a pruned tree with bounds/center normalized to 0–1; the `pruneLayout` + `parseBounds` logic is ported verbatim from the proven MCP and exported as pure functions.
