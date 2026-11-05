---
'@oniroproject/oniro-app': patch
'@oniroproject/core': patch
---

Fixes:

- `cmdtools install` no longer leaves the install directory half-written when it fails part-way (a full disk,
  say) (#16). The extracted tools are staged inside the install directory and swapped in only once complete; a
  failure before the swap leaves the existing tools untouched, one during it rolls them back, and a failed first
  install leaves no directory behind. A successful install replaces the directory's contents outright, so it holds
  exactly what a clean extraction of the archive holds, whatever an earlier attempt or an older version left there.
