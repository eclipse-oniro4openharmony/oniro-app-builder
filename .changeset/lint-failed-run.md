---
'@oniroproject/oniro-app': patch
'@oniroproject/core': patch
---

Fixes:

- `lint` no longer prints `No defects found.` when codelinter exited non-zero without a report. It says nothing was
  linted, and names the project-root files the directory lacks (`build-profile.json5`, `hvigorfile.ts` or `.js`,
  `hvigor/hvigor-config.json5`). Core exports `missingProjectRootFiles`.
