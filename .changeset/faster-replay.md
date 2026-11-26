---
'@oniroproject/core': minor
'@oniroproject/oniro-app': minor
---

A replay makes fewer calls to the device, and `doctor` says when each call is slow. Measured on a
phone reached through an SSH tunnel (0.2 s a call), a 32-step flow with a screenshot after every
step took 125 s before, 108 s now, and 81 s with two chosen screenshots instead of 32.

- **`doctor` has an `hdc-speed` check.** It times one hdc call (the median of three
  `hdc list targets`, then of three `hdc shell echo` on the device) and warns over 700 ms. It tells
  two causes apart: hdc is slow before it reaches any device, or only the way to the device is. A
  call that fails is not timed (the check is skipped): a device that is offline answers at once. The
  first was the case that prompted the check: an hdc client that finds no hdc server running on this
  machine starts one and sleeps 1.3 s before every call, also when a wrapper sends the call to a
  server elsewhere with `-s`. A 58-flow replay run took 131 minutes like that and 42 with `-p` in
  the wrapper, and nothing had said why. Core: `checkHdcSpeed`, `SLOW_HDC_CALL_MS`.
- **`replay --screenshot-steps <i,j,…>`** (core: `screenshotSteps`) photographs only the named steps
  instead of every step; `none` photographs no step. The divergence screenshot is taken either way.
- **A replay no longer asks for the display size and the installed input methods on every layout
  dump**, of which a step takes two or three: its dumps share what the first one learned. (A step that
  acts on a recorded fallback point still asks for the size.) The size is kept only while each dump
  agrees with it: uitest
  gives a dump's root node the bounds of the screen, so after a turn of the screen, or on a dump that
  does not state them, the size is asked for again. Core: `dumpLayout` takes a `cache`
  (`LayoutDumpCache`), which `waitForTarget`, `locateTarget`, `performInput` and `hideKeyboard` pass
  on as `dumpCache`; `dumpedDisplaySize` and `displayStillHolds` are the pure checks.
- **A screenshot's width and height are read from the JPEG's header** (`jpegSize`) instead of asked
  of the device: one call less per frame, and the size is the picture's own. The display is still
  asked when the header cannot be read.
