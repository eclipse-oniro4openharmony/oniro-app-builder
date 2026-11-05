import * as fs from 'node:fs';
import * as path from 'node:path';
import { findCoveredNodes, pruneLayout, type DisplaySize, type LayoutNode, type RawLayoutNode } from '../../src/hdc/index.js';

const DIR = path.join(__dirname, '..', 'fixtures', 'layout');

/** A recorded raw `uitest dumpLayout` tree and the display it was taken on. */
export function rawLayoutFixture(name: string): { display: DisplaySize; tree: RawLayoutNode } {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as { display: DisplaySize; tree: RawLayoutNode };
}

/** A recorded layout, pruned the way `dumpLayout` prunes it. */
export function layoutFixture(name: string): LayoutNode {
  const { display, tree } = rawLayoutFixture(name);
  const pruned = pruneLayout(tree, display, findCoveredNodes(tree));
  return Array.isArray(pruned) ? { children: pruned } : (pruned ?? { children: [] });
}

export function textFixture(name: string): string {
  return fs.readFileSync(path.join(DIR, name), 'utf8');
}
