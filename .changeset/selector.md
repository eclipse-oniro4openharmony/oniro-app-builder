---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- `--selector <expr>` on `input`, `wait` (including `--gone`), `screenshot` (crops to the element) and `dump layout`
  (lists only the matches, numbered), as an alternative to `--target` / `--target-id` / `--target-type`, which keep
  working unchanged. Attribute selectors: comma-separated `key<op>value` clauses over `text`, `desc`, `hint`, `id`,
  `key`, `type`, `enabled`, `focused`, `checked`, `selected`, `visible`, `clickable`, `longClickable`, `checkable`
  and `scrollable`, with `=`, `*=` (contains), `^=` (prefix), `$=` (suffix) and `/=` (regex, `/flags`), and a `[n]`
  suffix (0-based, `[-1]` / `[last]` from the end) that picks one match of the list `dump layout --selector` prints.
  `xpath=<expr>` evaluates a documented XPath subset over the same tree: `/`, `//`, `*`, `.`, `..`, `[@attr="v"]`,
  `[@attr]`, `!=`, `contains`, `starts-with`, `ends-with`, `not`, `text()`, `and` / `or`, `[n]`, `[last()]`,
  `[position()<n]` and `(path)[n]`. Anything outside the language is an error, not an empty match. Adapted from
  deveco-cli (MIT).
- `--window <id>` on `dump layout`, `input`, `wait` and `screenshot` restricts dumping, selection and the screenshot
  to one window. The layout is still dumped whole, so overlays from other windows still mark elements covered.
- `dump windows` lists every window from `hidumper -s WindowManagerService` (id, name, pid, type, z-order,
  rectangle, focus); `--json` for JSON.
- `dump layout --flat` window headers now carry the window id (`[window 92 com.example.app]`), and two windows of the
  same bundle get a header each. The JSON tree carries `windowId` on each window's root and `hidden` on components
  with `visible: false`; a structural container kept for its id or click handler keeps its type (`Column`, `Row`, …).
- Core exports `parseSelector`, `matchSelector`, `selectorFor` (the most specific stable selector for a recorded
  element, for record/replay), `formatSelector`, `parseXPath`, `evaluateXPath`, `findVisibleMatch`,
  `selectableTree`, `listLayoutWindows`, `windowSubtree`, `rawWindowSubtree`, `listWindows` and `parseWindowList`.
  `pickTarget`, `findLayoutNodes`, `locateTarget`, `performInput` and `waitForTarget` accept a parsed selector
  (`ElementQuery`), and `dumpLayout`, `locateTarget`, `performInput` and `waitForTarget` take `windowId`.
