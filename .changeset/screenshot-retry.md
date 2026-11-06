---
'@oniroproject/core': patch
'@oniroproject/oniro-app': patch
---

Fixes:

- `screenshot` retries a capture that wrote no file instead of failing with
  `hdc file recv ... no such file or directory`. `snapshot_display` gives up when
  RenderService does not deliver a frame within 2 s, which happens now and then
  while an app starts on the emulator (the flaky screenshot step of the
  end-to-end CI). Up to three attempts are made, `--burst` retries each frame the
  same way, and when every attempt fails the error quotes `snapshot_display`'s
  own message.
- Each screenshot uses its own file on the device. With one fixed name, the
  background clean-up of a previous capture in the same process (`serve`) could
  delete the next capture before it was pulled.
