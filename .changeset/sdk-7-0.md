---
'@oniroproject/core': minor
'@oniroproject/oniro-app': minor
---

Add OpenHarmony 7.0 (API 26) to the known SDKs, so `oniro-app sdk list` shows it and
`oniro-app sdk install 7.0` downloads it.

The mirror re-published 7.0 under dated archive names (`…_20260829.tar.gz`); the
undated archives hold `-Beta` components. `SdkRelease` gains an optional
`archiveSuffix`, which `getSdkFilename` appends to the archive basename, and 7.0 uses
it to fetch the `-Release` build.
