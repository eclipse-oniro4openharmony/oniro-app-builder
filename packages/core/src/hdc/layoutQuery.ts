import { OniroError } from '../ports/errors.js';
import type { FlatLayoutNode, LayoutNode } from './dump.js';

/** A `--selector` expression (attribute DSL or XPath) that does not parse. */
export class SelectorParseError extends OniroError {
  constructor(
    detail: string,
    /** Offset into `input` where parsing stopped. */
    readonly position: number,
    readonly input: string,
  ) {
    super(`Invalid selector ${JSON.stringify(input)} at ${position}: ${detail}`);
    this.name = 'SelectorParseError';
  }
}

/**
 * The element attributes a `--selector` expression (DSL key or XPath `@name`)
 * can test, read off the pruned tree `dump layout` prints. Strings compare as
 * they appear there; the boolean ones are always present as "true" or "false".
 */
export const SELECTOR_KEYS = [
  'text',
  'desc',
  'hint',
  'id',
  'key',
  'type',
  'enabled',
  'focused',
  'checked',
  'selected',
  'visible',
  'clickable',
  'longClickable',
  'checkable',
  'scrollable',
] as const;

export type SelectorKey = (typeof SELECTOR_KEYS)[number];

// Alternative spellings accepted on input (uitest's own attribute name).
const KEY_ALIASES: Readonly<Record<string, SelectorKey>> = { description: 'desc' };

/** The canonical key for `name` (`description` is `desc`), or undefined when it is not one. */
export function resolveSelectorKey(name: string): SelectorKey | undefined {
  if ((SELECTOR_KEYS as readonly string[]).includes(name)) return name as SelectorKey;
  return KEY_ALIASES[name];
}

const bool = (v: boolean | undefined): string => (v ? 'true' : 'false');

/**
 * The value of a selector attribute on a node. `key` falls back to `id` (the
 * pruned tree drops a key equal to the id); `enabled` is the inverse of
 * `disabled`; `visible` means drawn and not covered by an overlay.
 */
export function selectorAttribute(n: FlatLayoutNode, key: SelectorKey): string | undefined {
  switch (key) {
    case 'text':
      return n.text;
    case 'desc':
      return n.desc;
    case 'hint':
      return n.hint;
    case 'id':
      return n.id;
    case 'key':
      return n.key ?? n.id;
    case 'type':
      return n.type;
    case 'enabled':
      return bool(!n.disabled);
    case 'focused':
      return bool(n.focus);
    case 'checked':
      return bool(n.checked);
    case 'selected':
      return bool(n.sel);
    case 'visible':
      return bool(!n.hidden && !n.covered);
    case 'clickable':
      return bool(n.click);
    case 'longClickable':
      return bool(n.longClick);
    case 'checkable':
      return bool(n.check);
    case 'scrollable':
      return bool(n.scroll);
  }
}

/** A layout node's own fields, tagged with its enclosing window's bundle and id. */
export function flatLayoutNode(n: LayoutNode, window: string | undefined, windowId: number | undefined): FlatLayoutNode {
  const { children: _children, ...rest } = n;
  const out: FlatLayoutNode = { ...rest };
  if (window !== undefined) out.window = window;
  if (windowId !== undefined) out.windowId = windowId;
  return out;
}

/** The node carries fields of its own, not just children. */
export function hasOwnFields(n: LayoutNode): boolean {
  return Object.keys(n).some((k) => k !== 'children');
}

/** A pruned layout node with links to its parent and children, for selector and XPath evaluation. */
export interface IndexedLayoutNode {
  flat: FlatLayoutNode;
  parent: IndexedLayoutNode | null;
  children: IndexedLayoutNode[];
  /** Position in depth-first (paint) order. */
  order: number;
  /** A bare container: no fields of its own (it never matches a selector). */
  empty: boolean;
}

/** Link up a pruned tree; returns its root. Depth-first order matches {@link flattenLayout}. */
export function indexLayout(tree: LayoutNode): IndexedLayoutNode {
  let order = 0;
  const visit = (
    n: LayoutNode,
    parent: IndexedLayoutNode | null,
    window: string | undefined,
    windowId: number | undefined,
  ): IndexedLayoutNode => {
    const win = n.bundle ?? window;
    const winId = n.windowId ?? windowId;
    const entry: IndexedLayoutNode = {
      flat: flatLayoutNode(n, win, winId),
      parent,
      children: [],
      order: order++,
      empty: !hasOwnFields(n),
    };
    for (const c of n.children ?? []) entry.children.push(visit(c, entry, win, winId));
    return entry;
  };
  return visit(tree, null, undefined, undefined);
}

/** Every node of an indexed tree, depth-first. */
export function allIndexed(root: IndexedLayoutNode): IndexedLayoutNode[] {
  const out: IndexedLayoutNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}
