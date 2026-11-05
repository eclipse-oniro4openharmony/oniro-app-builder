import { Command } from 'commander';
import * as path from 'node:path';
import { inventoryScreens, type ScreensInventory } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

interface ScreensOpts {
  json?: boolean;
}

/** Left-aligned columns, two spaces apart, the last one unpadded. */
export function formatTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

/** The text report: pages, routes, placeholders and warnings, each as a table or a list. */
export function formatScreens(inv: ScreensInventory): string {
  const out: string[] = [];
  const multiModule = inv.modules.length > 1;
  out.push(`Pages (${inv.pages.length})`);
  if (inv.pages.length) {
    out.push(
      formatTable(
        ['NAME', ...(multiModule ? ['MODULE'] : []), 'KIND', 'COMPONENT', 'NODES', 'ROUTES OUT', 'FILE'],
        inv.pages.map((p) => [
          p.registered ? p.name : `${p.name} (unregistered)`,
          ...(multiModule ? [p.module] : []),
          p.kind,
          p.component ?? '-',
          String(p.contentNodes),
          p.routesOut.join(', ') || '-',
          `${p.file}:${p.line}`,
        ]),
      ),
    );
  }
  out.push('', `Routes (${inv.routes.length})`);
  if (inv.routes.length) {
    out.push(
      formatTable(
        ['FROM', 'TO', 'VIA', 'FILE'],
        inv.routes.map((r) => [r.from, r.dynamic ? `${r.to} (dynamic)` : r.to, r.via, `${r.file}:${r.line}`]),
      ),
    );
  }
  out.push('', `Placeholders (${inv.placeholders.length})`);
  if (inv.placeholders.length) {
    out.push(formatTable(['FILE', 'KIND', 'TEXT'], inv.placeholders.map((p) => [`${p.file}:${p.line}`, p.kind, p.text])));
  }
  if (inv.warnings.length) {
    out.push('', `Warnings (${inv.warnings.length})`);
    for (const w of inv.warnings) out.push(w);
  }
  return out.join('\n');
}

export function registerScreensCommand(program: Command): void {
  program
    .command('screens [project-dir]')
    .description(
      'Static inventory of the pages and routes of a project, from its sources, without a build or a device: ' +
        '@Entry pages (main_pages.json, @Entry({ routeName })), NavDestination pages (route maps and ' +
        '.navDestination() builders that dispatch on the route name), the router.pushUrl/replaceUrl/pushNamedRoute ' +
        'and NavPathStack.pushPath*/replacePath*/pushDestination* call sites, the content nodes each page renders ' +
        '(component calls through its custom components and @Builders, layout containers excluded), and ' +
        'placeholder markers (TODO/FIXME, placeholder-like text, empty build()). Reads every module in ' +
        'build-profile.json5. Exits 0 (it is an inventory, not a gate) unless the project cannot be read.',
    )
    .option(
      '--json',
      'Print the inventory as JSON: pages (name, module, file, line, component, entry, kind, registered, ' +
        'contentNodes, routesOut), routes (from, to, file, line, via, dynamic), placeholders (file, line, text, ' +
        'kind), warnings, modules, projectDir.',
    )
    .action((projectDir: string | undefined, opts: ScreensOpts) => {
      const { logger } = getRuntime();
      const dir = path.resolve(projectDir ?? process.cwd());
      let inv: ScreensInventory;
      try {
        inv = inventoryScreens({ projectDir: dir });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (opts.json) process.stdout.write(`${JSON.stringify({ error }, null, 2)}\n`);
        logger.error(error);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(opts.json ? `${JSON.stringify(inv, null, 2)}\n` : `${formatScreens(inv)}\n`);
    });
}
