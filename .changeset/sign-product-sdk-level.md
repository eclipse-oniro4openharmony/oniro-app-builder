---
'@oniroproject/core': patch
'@oniroproject/oniro-app': patch
---

`sign --product <name>` now reads the SDK level from that product's `compileSdkVersion`, not from
the first product's. A project that also targets HarmonyOS, with its HarmonyOS product listed
first, can sign its OpenHarmony product (`oniro-app sign --product oniro`) instead of failing
with "Could not detect project SDK version". `build --product` finds the SDK the same way, for
its missing-SDK check and for the SDK it names in failures. Without `--product`, the first
product is used, as before.
