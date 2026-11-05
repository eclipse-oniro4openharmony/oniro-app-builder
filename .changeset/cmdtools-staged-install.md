---
'@oniroproject/oniro-app': patch
'@oniroproject/core': patch
---

Fixes:

- `cmdtools install` no longer leaves the install directory half-written when it fails part-way (a full disk,
  say) (#16). The extracted tools are staged inside the install directory and swapped in only once complete; a
  failure before the swap leaves the existing tools untouched, one during it rolls them back, and a failed first
  install leaves no directory behind. A successful install replaces the tools' own entries (`bin`, `sdk`, `hvigor`,
  `tool`, … and whatever the archive brings) outright, whatever an earlier attempt or an older version left there;
  anything else in the directory is not the tools' and stays. If the rollback itself fails, the previous tools are
  kept in a directory the error names, never deleted.
