---
'@oniroproject/core': patch
'@oniroproject/oniro-app': patch
---

Recover the hdc connection to a TCP device (e.g. the emulator) that wedges after a
reboot. The hdc server can keep the old session "Connected": `hdc tconn` answers
"Target is connected, repeat operation" and every command fails until the server is
restarted, so `oniro-app reboot --wait-bundle` and `oniro-app wait` timed out. The
post-reboot waits now restart the hdc server (`hdc start -r`) and reconnect when tconn
claims a connection the device does not answer on three polls in a row.
