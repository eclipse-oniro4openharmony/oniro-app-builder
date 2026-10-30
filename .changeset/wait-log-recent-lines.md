---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

`wait --log` and `watch --log` only match lines logged after the command starts.

Changed:

- `hdc shell hilog` replays the buffer before it streams, so `wait --log` and `watch --log` used to return lines from
  minutes or hours ago (a previous run's `complete: done`, a 95 s old `status=503`), which answered "did X fire?"
  wrongly. They now skip lines logged before the command started, measured on the device clock. `--since <seconds>`
  also accepts lines up to N seconds before the command (useful right after a tap), and `--since all` restores the
  old behaviour. When the device clock can't be read, every line can match and a warning says so. `wait --log`
  prints the matched line's device time.
- In core, `waitForLog` and `watchLog` take a `lookbackMs` option (default 0, `Infinity` for the whole buffer), and
  `hilogTimeMs` is exported.
