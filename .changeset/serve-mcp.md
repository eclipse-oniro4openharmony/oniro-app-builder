---
'@oniroproject/oniro-app': minor
---

Features:

- New `serve mcp`: a Model Context Protocol server on stdio (newline-delimited JSON-RPC 2.0; `initialize` with
  protocol version negotiation from 2024-11-05 to 2025-11-25, `ping`, `tools/list`, `tools/call`) that exposes the
  gate commands as typed tools for other agents: `build`, `check_arkts`, `test`, `apply`, `launch` (with the smoke
  check), `dump_layout` (with `flat`, `summary` and `diff`), `input`, `screenshot` (an `image/jpeg` content block
  downscaled to `maxDim`, with `grid`, `crop`, `target*`, `contactSheet` and `diff`), `wait`, `logs_crash`, and the
  read-only `screens`, `api_search`, `api_show`, `doctor` and `devices`. Each tool calls the core function its
  command uses and returns the command's `--json` object as `structuredContent` and as JSON text; the input schemas
  are the command's flags with the same defaults and help text.
- A tool result has `isError: true` when the command would exit non-zero or could not run (bad arguments included),
  never a JSON-RPC error; stdout carries only the protocol and logs go to stderr.
- `--project` and `--device` set the defaults every call uses, `--tools <list>` restricts the exposed set and
  `--read-only` leaves out the tools that change the device (`apply`, `launch`, `input`, `test`). Register it with
  `claude mcp add oniro-app -- oniro-app serve mcp --project <dir>`.
- No new dependency: the protocol is a small hand-written JSON-RPC layer.
