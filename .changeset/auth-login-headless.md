---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- `auth login` completes when the browser is not on the build host (#20). `--manual` (or `--no-browser`) does not
  open a browser: it prints the URL, then takes the callback address the browser ends up on, pasted on stdin as the
  whole URL or its query, through the same checks as a request to the loopback port. `--port <n>` listens on a fixed
  port, so an `ssh -L <n>:127.0.0.1:<n>` tunnel can be set up beforehand. `--print-url` writes the URL alone to
  stdout and `--json` writes `{"loginUrl","port","callbackUrl"}` then the account as JSON lines, so scripts need not
  scrape stderr.
- Core: `session.login()` takes `port`, `openBrowser` and `pastedCallbacks` (`HarmonyOsLoginOptions`), and
  `onLoginUrl` receives the port.
