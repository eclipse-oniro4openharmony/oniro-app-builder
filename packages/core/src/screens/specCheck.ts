import type { ScreenPage, ScreenRoute, ScreensInventory } from './screens.js';

export interface ScreensSpec {
  /** Screens the spec asks for: a name, or a name with its own minimum. */
  screens?: Array<string | { name: string; minContentNodes?: number }>;
  /** Routes the spec asks for. Without `from`, a push call site anywhere in the app satisfies it. */
  routes?: Array<{ from?: string; to: string }>;
  /** Content nodes every screen needs (default 1). */
  minContentNodes?: number;
}

export interface ScreenSpecResult {
  name: string;
  ok: boolean;
  required: number;
  /** The best matching page (the one with the most content nodes). */
  page?: string;
  file?: string;
  contentNodes?: number;
  reason?: string;
}

export interface RouteSpecResult {
  from?: string;
  to: string;
  ok: boolean;
  /** The first call site that satisfies the route. */
  site?: Pick<ScreenRoute, 'from' | 'to' | 'file' | 'line' | 'via'>;
  reason?: string;
}

export interface ScreensSpecReport {
  ok: boolean;
  screens: ScreenSpecResult[];
  routes: RouteSpecResult[];
  /** One line per failed screen or route. */
  failures: string[];
}

const norm = (s: string): string => s.trim().toLowerCase();
const lastSegment = (s: string): string => s.replace(/\/+$/, '').split('/').pop() ?? s;

/** The names a page answers to: its route name, that name's last path segment, its component. */
function pageIds(p: ScreenPage): Set<string> {
  const ids = new Set([norm(p.name), norm(lastSegment(p.name))]);
  if (p.component) ids.add(norm(p.component));
  return ids;
}

/** Pages a spec name refers to, by route name, last path segment (`pages/Detail` -> `Detail`) or component, ignoring case. */
export function pagesMatching(inventory: Pick<ScreensInventory, 'pages'>, name: string): ScreenPage[] {
  const want = [norm(name), norm(lastSegment(name))];
  return inventory.pages.filter((p) => {
    const ids = pageIds(p);
    return want.some((w) => ids.has(w));
  });
}

/** Whether two screen references (`pages/Detail`, `Detail`, `DetailPage`) name the same screen in this inventory. */
function sameScreen(inventory: Pick<ScreensInventory, 'pages'>, a: string, b: string): boolean {
  const ids = (x: string): Set<string> => {
    const out = new Set([norm(x), norm(lastSegment(x))]);
    for (const p of pagesMatching(inventory, x)) for (const id of pageIds(p)) out.add(id);
    return out;
  };
  const ia = ids(a);
  for (const id of ids(b)) if (ia.has(id)) return true;
  return false;
}

/**
 * The G2 gate as a pure function of a `screens` inventory: every spec screen has a page with at least
 * `minContentNodes` content nodes, and every spec route has a push or replace call site (`router.pushUrl`,
 * `NavPathStack.pushPathByName`, ...; `loadContent` and non-literal targets do not count). A route's `from`
 * matches the page holding the call site, or a page whose `routesOut` (which includes the custom components it
 * renders) has the target. Names match a page's route name, its last path segment or its component, ignoring case.
 */
export function checkScreensAgainstSpec(
  inventory: Pick<ScreensInventory, 'pages' | 'routes'>,
  spec: ScreensSpec,
): ScreensSpecReport {
  const defaultMin = spec.minContentNodes ?? 1;
  const failures: string[] = [];

  const screens = (spec.screens ?? []).map((entry): ScreenSpecResult => {
    const name = typeof entry === 'string' ? entry : entry.name;
    const required = (typeof entry === 'string' ? undefined : entry.minContentNodes) ?? defaultMin;
    const candidates = pagesMatching(inventory, name);
    if (!candidates.length) {
      failures.push(`screen ${name}: no page`);
      return { name, ok: false, required, reason: 'no page' };
    }
    const best = candidates.reduce((a, b) => (b.contentNodes > a.contentNodes ? b : a));
    const ok = best.contentNodes >= required;
    const result: ScreenSpecResult = { name, ok, required, page: best.name, file: best.file, contentNodes: best.contentNodes };
    if (!ok) {
      result.reason = `${best.contentNodes} content nodes, needs ${required}`;
      failures.push(`screen ${name}: page ${best.name} (${best.file}) has ${result.reason}`);
    }
    return result;
  });

  const routes = (spec.routes ?? []).map((want): RouteSpecResult => {
    const sites = inventory.routes.filter((r) => !r.dynamic && r.via !== 'loadContent' && sameScreen(inventory, r.to, want.to));
    let match: ScreenRoute | undefined;
    if (want.from === undefined) {
      match = sites[0];
    } else {
      const from = want.from;
      const fromPages = pagesMatching(inventory, from);
      match =
        sites.find((r) => sameScreen(inventory, r.from, from)) ??
        sites.find((r) => fromPages.some((p) => p.routesOut.includes(r.to)));
    }
    const base = { ...(want.from !== undefined ? { from: want.from } : {}), to: want.to };
    if (match) {
      const { from, to, file, line, via } = match;
      return { ...base, ok: true, site: { from, to, file, line, via } };
    }
    const reason = sites.length ? `no call site from ${want.from}` : 'no push call site';
    failures.push(`route ${want.from ?? '*'} -> ${want.to}: ${reason}`);
    return { ...base, ok: false, reason };
  });

  return { ok: failures.length === 0, screens, routes, failures };
}
