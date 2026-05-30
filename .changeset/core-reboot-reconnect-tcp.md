---
"@oniroproject/core": patch
---

`reboot`/`waitForBundle`/`waitForBoot` now reconnect a TCP target across a reboot.

hdc auto-reconnects a USB device when it re-enumerates, but a TCP target (e.g. an emulator at `127.0.0.1:55555`) must be reconnected explicitly with `hdc tconn` after the session drops — and a reboot drops it. Previously the post-reboot wait kept polling `pidof` over the dead socket and timed out even though the device had come back. The wait now re-issues `hdc tconn <serial>` (best-effort) before each poll when `deviceSerial` is a `host:port` address; USB serials and the no-serial case are unaffected.
