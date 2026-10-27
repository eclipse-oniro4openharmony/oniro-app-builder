import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';
import { shell, ensureOk } from './exec.js';
import { recvFile } from './files.js';
import { getDisplaySize, type DisplaySize } from './display.js';
import { getImeBundles, findKeyboardWindow } from './ime.js';

/** A raw `uitest dumpLayout` node (attributes are strings). */
export interface RawLayoutNode {
  attributes?: Record<string, string>;
  children?: RawLayoutNode[];
}

/** A pruned, 0–1-normalized layout node. */
export interface LayoutNode {
  /** bounds [x1,y1,x2,y2] normalized to 0–1 of the display. */
  b?: [number, number, number, number];
  /** center [x,y] normalized to 0–1. */
  c?: [number, number];
  type?: string;
  text?: string;
  desc?: string;
  /** Placeholder text, e.g. an empty TextInput's "you@example.com". */
  hint?: string;
  id?: string;
  key?: string;
  bundle?: string;
  click?: boolean;
  check?: boolean;
  checked?: boolean;
  sel?: boolean;
  focus?: boolean;
  scroll?: boolean;
  longClick?: boolean;
  /** The component is disabled (`enabled: false`). */
  disabled?: boolean;
  /** The node's center is painted over by a later filled node (an overlay, a
   *  dialog scrim, the soft keyboard), so a tap there would land on that instead. */
  covered?: boolean;
  children?: LayoutNode[];
}

/** The soft keyboard, when an input-method window is on screen. */
export interface KeyboardState {
  shown: boolean;
  /** Bundle of the input-method window. */
  bundle?: string;
  /** Bounds [x1,y1,x2,y2] normalized to 0–1 of the display. */
  b?: [number, number, number, number];
}

export interface DumpLayoutResult {
  display: DisplaySize | null;
  tree: LayoutNode;
  /** Present when the dump was asked to detect the soft keyboard. */
  keyboard?: KeyboardState;
}

/** Parse a uitest bounds string `"[x1,y1][x2,y2]"` into a tuple, or null. */
export function parseBounds(s: string | undefined): [number, number, number, number] | null {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(s ?? '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

// Container types that almost never carry useful info on their own.
const STRUCTURAL_TYPES = new Set([
  'Stack', 'Column', 'Row', 'Flex', '__Common__', 'Grid', 'GridItem',
  'List', 'ListItem', 'Scroll', 'Swiper', 'SwiperContent', 'Navigator',
  'Tabs', 'TabContent', 'RelativeContainer', 'WaterFlow', 'FlowItem',
]);

const FLAG_MAP: ReadonlyArray<[string, keyof LayoutNode]> = [
  ['clickable', 'click'],
  ['checkable', 'check'],
  ['checked', 'checked'],
  ['selected', 'sel'],
  ['focused', 'focus'],
  ['scrollable', 'scroll'],
  ['longClickable', 'longClick'],
];

/** Alpha (0–255) of a uitest `#AARRGGBB` / `#RRGGBB` color; 0 when absent or malformed. */
function colorAlpha(color: string | undefined): number {
  const m = /^#([0-9a-f]{2})?[0-9a-f]{6}$/i.exec(color ?? '');
  if (!m) return 0;
  return m[1] === undefined ? 255 : parseInt(m[1], 16);
}

/** Whether a node paints a visible fill over whatever was drawn before it. */
function paintsFill(a: Record<string, string>): boolean {
  if (a.visible === 'false') return false;
  if (a.opacity !== undefined && a.opacity !== '' && !(Number(a.opacity) > 0)) return false;
  return colorAlpha(a.backgroundColor) > 0;
}

/**
 * Find nodes whose center is painted over by a later node with a visible
 * background fill — a full-screen overlay, a dialog scrim, a sticky bar, or the
 * soft-keyboard window. Paint order is depth-first, siblings ordered by
 * `zIndex`, windows in dump order; ancestors and descendants never cover a node.
 *
 * A heuristic: only background fills count (an Image or Text drawn on top does
 * not), which is what overlays in practice use.
 */
export function findCoveredNodes(root: RawLayoutNode): Set<RawLayoutNode> {
  interface Painted {
    node: RawLayoutNode;
    bounds: [number, number, number, number] | null;
    /** Index just past this node's last descendant in `order`. */
    end: number;
  }
  const order: Painted[] = [];
  const fills: number[] = [];
  const visit = (n: RawLayoutNode): void => {
    const a = n.attributes ?? {};
    const entry: Painted = { node: n, bounds: parseBounds(a.bounds), end: 0 };
    if (entry.bounds && paintsFill(a)) fills.push(order.length);
    order.push(entry);
    const kids = (n.children ?? [])
      .map((c, i) => ({ c, i, z: Number(c.attributes?.zIndex) || 0 }))
      .sort((p, q) => p.z - q.z || p.i - q.i);
    for (const k of kids) visit(k.c);
    entry.end = order.length;
  };
  visit(root);

  const covered = new Set<RawLayoutNode>();
  for (const p of order) {
    if (!p.bounds) continue;
    const cx = (p.bounds[0] + p.bounds[2]) / 2;
    const cy = (p.bounds[1] + p.bounds[3]) / 2;
    for (const j of fills) {
      if (j < p.end) continue;
      const q = order[j]!.bounds!;
      if (cx >= q[0] && cx < q[2] && cy >= q[1] && cy < q[3]) {
        covered.add(p.node);
        break;
      }
    }
  }
  return covered;
}

/**
 * Prune a raw `uitest dumpLayout` tree into a compact, signal-bearing tree with
 * bounds/center normalized to 0–1 of the display. Structural wrapper nodes with
 * no signal collapse into their children. Returns a node, a flat list of nodes
 * (collapsed wrapper with multiple children), or null (nothing useful). Ported
 * from the proven MCP `pruneNode`; `covered` (from {@link findCoveredNodes})
 * marks nodes hidden under an overlay.
 */
export function pruneLayout(
  node: RawLayoutNode,
  display: DisplaySize | null,
  covered?: ReadonlySet<RawLayoutNode>,
): LayoutNode | LayoutNode[] | null {
  const a = node.attributes ?? {};
  const px = parseBounds(a.bounds);
  const out: LayoutNode = {};
  if (px && display) {
    const w = display.width || 1;
    const h = display.height || 1;
    out.b = [
      +(px[0] / w).toFixed(3),
      +(px[1] / h).toFixed(3),
      +(px[2] / w).toFixed(3),
      +(px[3] / h).toFixed(3),
    ];
    out.c = [+(((px[0] + px[2]) / 2) / w).toFixed(3), +(((px[1] + px[3]) / 2) / h).toFixed(3)];
  }
  if (a.type && !STRUCTURAL_TYPES.has(a.type)) out.type = a.type;
  if (a.text) out.text = a.text;
  if (a.description) out.desc = a.description;
  if (a.hint) out.hint = a.hint;
  if (a.id) out.id = a.id;
  if (a.key && a.key !== a.id) out.key = a.key;
  if (a.bundleName) out.bundle = a.bundleName;
  for (const [attr, short] of FLAG_MAP) {
    if (a[attr] === 'true') (out[short] as boolean) = true;
  }
  if (a.enabled === 'false') out.disabled = true;
  if (covered?.has(node)) out.covered = true;

  const children: LayoutNode[] = [];
  for (const c of node.children ?? []) {
    const pc = pruneLayout(c, display, covered);
    if (pc) {
      if (Array.isArray(pc)) children.push(...pc);
      else children.push(pc);
    }
  }

  const hasSignal = Boolean(
    out.text || out.desc || out.hint || out.id || out.key || out.click ||
      out.scroll || out.check || out.longClick || out.bundle ||
      (out.type && out.type !== 'root'),
  );

  if (!hasSignal && children.length === 0) return null;
  // Collapse structural wrappers: pass children up to the parent.
  if (!hasSignal) return children.length === 1 ? children[0]! : children;

  if (children.length) out.children = children;
  return out;
}

/** A pruned layout node without children, tagged with the window it belongs to. */
export interface FlatLayoutNode extends Omit<LayoutNode, 'children'> {
  /** Bundle of the enclosing window (the nearest node carrying `bundle`). */
  window?: string;
}

/** Flatten a pruned layout tree into a depth-first (paint-order) list. */
export function flattenLayout(tree: LayoutNode): FlatLayoutNode[] {
  const out: FlatLayoutNode[] = [];
  const visit = (n: LayoutNode, window: string | undefined): void => {
    const { children, ...rest } = n;
    const win = n.bundle ?? window;
    if (Object.keys(rest).length > 0) out.push({ ...rest, ...(win ? { window: win } : {}) });
    for (const c of children ?? []) visit(c, win);
  };
  visit(tree, undefined);
  return out;
}

/** Selects layout nodes by what an agent can read off the screen. */
export interface LayoutSelector {
  /** Matches `text`, `desc`, or `hint`: case-insensitive exact matches win; otherwise substring matches. */
  text?: string;
  /** Matches `id` or `key` exactly. */
  id?: string;
  /** Restricts to a component type (e.g. `Button`, `TextInput`); case-insensitive. */
  type?: string;
}

/** Throw unless `selector` constrains something: a non-blank text, an id, or a type. */
export function assertLayoutSelector(selector: LayoutSelector): void {
  if (selector.text === undefined && selector.id === undefined && selector.type === undefined) {
    throw new OniroError('A layout selector needs a text, id, or type.');
  }
  if (selector.text !== undefined && selector.text.trim() === '') {
    throw new OniroError('A layout selector text must not be blank.');
  }
}

/**
 * The tree without the windows owned by `bundle` — e.g. the soft keyboard, whose
 * keys ("Done", "9") would otherwise match element selectors. Pure.
 */
export function withoutWindow(tree: LayoutNode, bundle: string): LayoutNode {
  const children = (tree.children ?? []).filter((c) => c.bundle !== bundle).map((c) => withoutWindow(c, bundle));
  return tree.children ? { ...tree, children } : tree;
}

/**
 * Find the nodes matching `selector` in a pruned layout tree, in paint order.
 * For `text`, exact (case-insensitive, trimmed) matches are returned when any
 * exist; otherwise substring matches. Covered nodes are included — callers
 * decide what to do with them (see {@link pickTarget}).
 */
export function findLayoutNodes(tree: LayoutNode, selector: LayoutSelector): FlatLayoutNode[] {
  assertLayoutSelector(selector);
  const type = selector.type?.toLowerCase();
  const nodes = flattenLayout(tree).filter(
    (n) =>
      (type === undefined || n.type?.toLowerCase() === type) &&
      (selector.id === undefined || n.id === selector.id || n.key === selector.id),
  );
  if (selector.text === undefined) return nodes;

  const want = selector.text.trim().toLowerCase();
  const labels = (n: FlatLayoutNode): string[] =>
    [n.text, n.desc, n.hint].filter((s): s is string => !!s).map((s) => s.trim().toLowerCase());
  const exact = nodes.filter((n) => labels(n).some((l) => l === want));
  if (exact.length > 0) return exact;
  return nodes.filter((n) => labels(n).some((l) => l.includes(want)));
}

function describeSelector(s: LayoutSelector): string {
  const parts: string[] = [];
  if (s.text !== undefined) parts.push(`text "${s.text}"`);
  if (s.id !== undefined) parts.push(`id "${s.id}"`);
  if (s.type !== undefined) parts.push(`type ${s.type}`);
  return parts.join(', ');
}

/** One-line summary of a node, used in errors and logs. */
export function describeLayoutNode(n: FlatLayoutNode): string {
  const label = n.text ?? n.desc ?? (n.hint !== undefined ? `hint: ${n.hint}` : undefined);
  const at = n.c ? ` at ${n.c[0].toFixed(3)},${n.c[1].toFixed(3)}` : '';
  return `${n.type ?? 'node'}${label !== undefined ? ` "${label}"` : ''}${n.id ? ` #${n.id}` : ''}${at}`;
}

const area = (b: [number, number, number, number] | undefined): number => (b ? (b[2] - b[0]) * (b[3] - b[1]) : 0);

/** `outer` is larger than `inner` and contains its center. */
function enclosesTarget(outer: FlatLayoutNode, inner: FlatLayoutNode): boolean {
  const b = outer.b;
  const c = inner.c;
  if (!b || !c) return false;
  return c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3] && area(b) > area(inner.b);
}

/** Why {@link pickTarget} could not choose a node. */
export type PickTargetFailure = 'none' | 'covered' | 'ambiguous';

export class TargetNotFoundError extends OniroError {
  constructor(
    message: string,
    readonly reason: PickTargetFailure,
  ) {
    super(message);
    this.name = 'TargetNotFoundError';
  }
}

/**
 * Choose the single node to act on for `selector`. Covered nodes are skipped;
 * clickable matches are preferred over plain ones (a "Sign in" Button over the
 * "Sign in" title); a match nested inside another clickable match collapses
 * into it. `index` picks among what remains, in paint order. Throws
 * {@link TargetNotFoundError} when nothing (or more than one node) qualifies.
 */
export function pickTarget(tree: LayoutNode, selector: LayoutSelector, index?: number): FlatLayoutNode {
  const matches = findLayoutNodes(tree, selector).filter((n) => n.c !== undefined);
  const what = describeSelector(selector);
  if (matches.length === 0) {
    throw new TargetNotFoundError(`No on-screen element matches ${what}. Run \`oniro-app dump layout --flat\` to see what is there.`, 'none');
  }
  const visible = matches.filter((n) => !n.covered);
  if (visible.length === 0) {
    throw new TargetNotFoundError(
      `Found ${matches.length} element(s) matching ${what}, but each is covered by an overlay ` +
        `(dialog, keyboard, or another layer): ${matches.map(describeLayoutNode).join('; ')}.`,
      'covered',
    );
  }
  const clickable = visible.filter((n) => n.click);
  const preferred = clickable.length > 0 ? clickable : visible;
  // A label nested inside a clickable match (a Button's own Text) is the same target.
  const candidates = preferred.filter((n) => !preferred.some((o) => o !== n && o.click && enclosesTarget(o, n)));
  if (index !== undefined) {
    const picked = candidates[index];
    if (!picked) {
      throw new TargetNotFoundError(`Index ${index} is out of range: ${candidates.length} element(s) match ${what}.`, 'ambiguous');
    }
    return picked;
  }
  if (candidates.length > 1) {
    throw new TargetNotFoundError(
      `${candidates.length} elements match ${what}; pass an index to choose: ` +
        candidates.map((n, i) => `[${i}] ${describeLayoutNode(n)}`).join('; '),
      'ambiguous',
    );
  }
  return candidates[0]!;
}

export interface DumpLayoutOptions {
  config: ConfigProvider;
  /** Filter to a single window/bundle (`uitest dumpLayout -b '<bundle>'`). */
  bundleName?: string;
  /** When false, return the parsed-but-unpruned tree. Default true. */
  prune?: boolean;
  /**
   * Also report whether the soft keyboard is on screen (one extra `hidumper` call).
   * Ignored with `bundleName`, which filters the keyboard window out of the dump.
   */
  detectKeyboard?: boolean;
  deviceSerial?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Dump the current on-screen layout via `uitest dumpLayout`, pull the JSON, and
 * return a pruned, 0–1-normalized tree (or the raw parsed tree when `prune:false`).
 */
export async function dumpLayout(opts: DumpLayoutOptions): Promise<DumpLayoutResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const bundleArg = opts.bundleName ? ` -b '${opts.bundleName.replace(/'/g, `'\\''`)}'` : '';
  const dump = await shell({ config: opts.config, command: `uitest dumpLayout${bundleArg}`, deviceSerial: opts.deviceSerial, timeoutMs });
  ensureOk(dump, 'uitest dumpLayout');

  const m = dump.stdout.match(/saved to:\s*(\S+)/i);
  if (!m) throw new OniroError(`Could not parse dumpLayout output:\n${dump.stdout}`);
  const remote = m[1]!;
  const local = path.join(os.tmpdir(), `oniro_layout_${randomBytes(6).toString('hex')}.json`);

  try {
    await recvFile({ config: opts.config, remote, local, deviceSerial: opts.deviceSerial, timeoutMs });
    const parsed = JSON.parse(await fs.promises.readFile(local, 'utf8')) as RawLayoutNode;
    const display = await getDisplaySize(opts.config, { deviceSerial: opts.deviceSerial });

    if (opts.prune === false) {
      return { display, tree: parsed as unknown as LayoutNode };
    }
    const prunedRaw = pruneLayout(parsed, display, findCoveredNodes(parsed));
    const tree: LayoutNode = Array.isArray(prunedRaw) ? { children: prunedRaw } : prunedRaw ?? { children: [] };
    if (!opts.detectKeyboard || opts.bundleName) return { display, tree };

    const imeBundles = await getImeBundles(opts.config, { deviceSerial: opts.deviceSerial, logger: opts.logger });
    const kb = findKeyboardWindow(tree, imeBundles);
    const keyboard: KeyboardState = kb ? { shown: true, bundle: kb.bundle, ...(kb.b ? { b: kb.b } : {}) } : { shown: false };
    return { display, tree, keyboard };
  } finally {
    fs.promises.unlink(local).catch(() => {});
    void shell({ config: opts.config, command: `rm -f ${remote}`, deviceSerial: opts.deviceSerial }).catch(() => {});
  }
}
