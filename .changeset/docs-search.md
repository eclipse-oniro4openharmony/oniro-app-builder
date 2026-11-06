---
"@oniroproject/core": minor
"@oniroproject/oniro-app": minor
---

Features:

- New `docs sync`, `docs search <query...>` and `docs show <path>`: the OpenHarmony application-development
  documentation (gitcode.com/openharmony/docs, `en/application-dev`) of the release matching the SDK, for what the
  SDK typings behind `api search` cannot say: how an API is used, a component's attributes, the business error codes
  a kit throws, platform behaviour (lifecycle, permissions, threads). `docs sync` clones one release's tree (a
  partial, sparse clone without figures, about 100 MB; `6.1.0.x` → `OpenHarmony-6.1-Release`, or `--ref`) under
  `<sdkRootDir>/docs` (`ONIRO_DOCS_DIR`). `docs search` ranks documents containing every word by where the words
  occur (title, headings, path, body), names the matching sections and exits 1 on none; `docs show` prints one
  document or one section by `--heading`, images dropped, cut at `--lines`. The SDK is `--api`, `--sdk` or the
  project's `compileSdkVersion`, as for `api search`. `--json` on each.
- `serve mcp` exposes them as `docs_search` and `docs_show` (read-only; `isError` with the sync instruction when the
  release is not cloned).
- Core: `syncDocs`, `docsRefFor`, `readSdkRelease`, `getDocsRootDir`, `docsDirFor`, `docsTree`, `DocsIndex`
  (`load`, `search`, `show`), the `docsDir` config key.
