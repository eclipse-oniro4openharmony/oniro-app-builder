---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- New `screens [project-dir]`: a static inventory of a project's pages and routes, from the sources of every module
  in `build-profile.json5`, with no build, SDK or device. Pages are the `@Entry` pages of `main_pages.json` (and
  `@Entry({ routeName })` named routes) and the `NavDestination`s registered in a route map (`routerMap`) or in a
  `.navDestination(builder)` builder that dispatches on the route name; unlisted `@Entry` structs and unregistered
  `NavDestination` structs are listed as unregistered. Each page has its content-node count (the component calls it
  renders through its custom components and `@Builder`s, layout containers excluded) and its routes out. Routes are
  the `router` `pushUrl`/`replaceUrl`/`pushNamedRoute`/`replaceNamedRoute` and `NavPathStack`
  `pushPath*`/`replacePath*`/`pushDestination*` call sites and `loadContent`, with literal, constant and local
  `RouterOptions` targets resolved. Placeholders are `TODO`/`FIXME` comments, placeholder-like text in code and
  `string.json` (`placeholder`, `lorem ipsum`, `coming soon`, `Hello World`, ...), empty `build()`s and pages with no
  content. Prints tables, or the inventory with `--json`. Exits 0, or 1 when the project cannot be read.
- Core exports `inventoryScreens`, and `checkScreensAgainstSpec`, the G2 gate ("every spec screen has a page with at
  least k content nodes and every spec route has a push call site") as a pure function of the inventory, plus
  `pagesMatching`, `scanEts` and `LAYOUT_COMPONENTS`.
