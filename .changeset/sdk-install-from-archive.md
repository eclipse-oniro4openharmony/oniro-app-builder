---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Install an OpenHarmony SDK from a local archive, which is how the full SDK gets installed.

- `sdk install --from-archive <path>` installs a local SDK `.tar.gz`, such as an `ohos-sdk-full` archive from the
  OpenHarmony daily builds (https://dcp.openharmony.cn/workbench/cicd/dailybuild/dailylist), which the release mirror
  does not carry. Only the current OS's components are unpacked, wherever they sit in the archive, and the API level
  is read from their `oh-uni-package.json`. An SDK already installed at that level is replaced only with `--force`.
  `sdk install --help`, and `sdk install` with neither a version nor an archive, point at the daily builds.
- The system-API build hint (`'…' is not exported from Kit '…'`) now names the daily builds and
  `sdk install --from-archive` instead of describing a manual unpack.
- Core exports `installSdkFromArchive`, `findSdkOsDir`, `readZipEntry` and `OHOS_DAILY_BUILDS_URL`;
  `extractTarball` takes an optional entry filter.
