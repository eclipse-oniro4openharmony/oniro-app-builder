---
'@oniroproject/core': minor
'@oniroproject/oniro-app': minor
---

Make driving the UI from an agent less error-prone.

- `oniro-app dump layout --flat` prints one line per labelled or interactive element
  (type, label, `#id`, center as 0–1 fractions, flags), grouped by window, with the
  soft keyboard collapsed to one line. The JSON output stays the default.
- The pruned layout now reports placeholder text (`hint`), `disabled` components, and
  `covered` elements, meaning those painted over by a later layer with a visible
  background (a dialog scrim, an overlay, the keyboard). With keyboard detection it
  also carries `keyboard: { shown, bundle, b }`.
- `oniro-app input` can act on an element by label with `--target` (plus
  `--target-id`, `--target-type` and `--target-index`), or take a position as 0–1
  fractions with `--fx`/`--fy`/`--fx2`/`--fy2`.
  - Covered elements are skipped and clickable ones are preferred. An ambiguous match
    fails and lists the candidates.
  - When the soft keyboard hides the element, it is dismissed first.
- New input types:
  - `clearText` clears a field with Ctrl+A then Delete.
  - `hideKeyboard` presses Back only when the keyboard is shown.
- `inputText` gains `--clear`, and any action can take `--hide-keyboard`.
- `--key` accepts named keys (`Delete`, `Enter`, `Tab`, `Escape`, `MoveHome`, …),
  letters, and combos of up to three keys such as `Ctrl+A`.
- `oniro-app wait --target <text> [--gone]` waits for an element to appear or
  disappear.
- `oniro-app screenshot --crop x1,y1,x2,y2` and `--target <text>` write a
  full-resolution crop of one region or element.
- `oniro-app gesture --fractions` takes waypoints as 0–1 fractions.
- Core exports `performInput`, `locateTarget`, `hideKeyboard`, `waitForTarget`,
  `flattenLayout`, `findLayoutNodes`, `pickTarget`, `findCoveredNodes`,
  `resolveKeyEvent`, and the IME helpers.
