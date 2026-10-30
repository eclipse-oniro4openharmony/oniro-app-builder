---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

`app apply` no longer installs another app's HAP.

Changed:

- `app apply` refuses a HAP whose bundleName differs from the bundle being applied, before it touches the device. It
  also accepts a `.hap` file as the positional argument, as `app install` does, and then takes the bundle name from
  the HAP. Core exports `readHapBundleName`.

Fixes:

- `discoverHaps` (used by `app install` and `app apply`) skips another app project nested inside the project (a
  subdirectory with its own `AppScope/app.json5`), whose newer HAP used to win and replace the wrong app.
