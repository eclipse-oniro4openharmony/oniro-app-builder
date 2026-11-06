---
'@oniroproject/core': patch
---

`replayFlow` no longer dumps the same screen two or three times per step: the dump in which a step's selector (or the previous step's `expect`) was found is reused to locate the element the step acts on, and the next step's selector is looked up in it before the screen is dumped again. A dump taken within `settleMs` (default 1500) of the last action may show a screen in transition, so before a step acts on an element found in one the screen is dumped once more and the element must be the same node at the same place. On a phone a dump costs about a second, so flows replay noticeably faster with the same outcomes. `locateTarget` and `performInput` take an optional `layout` to look in first; `waitForTargetLayout` is `waitForTarget` returning the dump too.
