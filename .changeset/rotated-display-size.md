---
'@oniroproject/core': patch
'@oniroproject/oniro-app': patch
---

Fixes:

- Device commands now work on a screen rotated to landscape. They used the
  panel's portrait size, so `dump layout` reported `display 1080x2400` with
  fractions above 1. `input --target`, `--selector` and `--fx/--fy` tapped the
  wrong place (x was clamped to the portrait width). `screenshot --target` and
  `--selector` cropped a sliver at the edge of the image instead of the element.
  The display size now comes from RenderService plus the display manager's
  `ScreenRotation`, so width and height follow the rotation. `screenshot`,
  `record` and the lock-screen swipe use the same size.
