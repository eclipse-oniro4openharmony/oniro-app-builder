---
'@oniroproject/oniro-app': minor
---

New `store` command group: publish apps to the Oniro App Store from a terminal or CI job.

- `store login --token <oas_…>` checks an API token created on the store website and saves it
  (`~/.oniro/store/credentials.json`, mode 0600, keyed by store URL); `store logout` and
  `store whoami` manage it. `ONIRO_STORE_TOKEN` wins over the saved token, and `ONIRO_STORE_URL`
  or `--url` picks the store (default `https://store.iparo.app`).
- `store publish <file.hap|file.app>` reads the bundle name from the package, creates the listing
  on the first publish (`--name`, `--description`, `--category`, `--tags`, `--icon`, `--vendor`,
  `--source-url`) and adds a new version afterwards.
- `store register-release --repo owner/name --tag v1.2.0 --asset app.app` publishes a package
  that stays hosted on a public GitHub release; its sha256 comes from GitHub's digest, a local
  `--file`, or a download.
- Requests honour `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, and wait up to 15 minutes for the
  store to check a large package. A token with stray spaces or line breaks is refused without
  being echoed.
