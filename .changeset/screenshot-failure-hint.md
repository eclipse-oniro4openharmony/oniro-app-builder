---
'@oniroproject/core': patch
'@oniroproject/oniro-app': patch
---

`screenshot`: when every capture attempt fails, the error no longer blames a
2 s RenderService stall. It says RenderService returned no image each time and
shows how to read the reason from the device log (`hilog`). The end-to-end CI
failure this hint was written for was in fact an emulator image bug (fixed in
Oniro Emulator v7.0.1).
