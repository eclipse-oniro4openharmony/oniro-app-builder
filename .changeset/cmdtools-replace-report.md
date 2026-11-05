---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- `cmdtools install --force` says what it replaces before deleting it (#25), e.g.
  `Replacing command-line tools 5.1.0.840 (HarmonyOS 5.1.0, API 18, hvigor 5.18.5) with 6.1.1.280 (HarmonyOS 6.1.1,
  API 24, hvigor 6.24.2).`. Further lines say when hvigor changes major version, when the new release is older, and
  how to go back. The final line names the installed release, and without `--force` the message names the release
  already installed.
- `installCmdTools` returns `{ path, installed, previous? }` with both releases' `CmdToolsInfo` (version, flavour,
  SDK, tool versions), and core exports `describeReplacement`.
