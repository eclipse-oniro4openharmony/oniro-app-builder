import { OniroError } from '../ports/errors.js';
import { flattenLayout, type DumpLayoutResult, type FlatLayoutNode, type LayoutNode } from './dump.js';

type Box = [number, number, number, number];

/** Window name used for nodes outside any bundle window. */
export const NO_WINDOW = '(none)';

/** Counts for one window of a layout. */
export interface LayoutWindowSummary {
  /** Bundle owning the window, or `(none)` for nodes outside any bundle window. */
  window: string;
  /** Pruned elements in the window. */
  elements: number;
  /** Elements that carry something to read: text, description, placeholder, or an image. */
  content: number;
  /** Clickable elements. */
  clickable: number;
  /** Elements with non-empty text. */
  text: number;
}

export interface LayoutSummary {
  display: DumpLayoutResult['display'];
  windows: LayoutWindowSummary[];
  /** The same counts over the whole layout. */
  total: Omit<LayoutWindowSummary, 'window'>;
  /** Present when the dump detected the soft keyboard. */
  keyboard?: DumpLayoutResult['keyboard'];
}

const isContent = (n: FlatLayoutNode): boolean =>
  !!(n.text || n.desc || n.hint) || n.type === 'Image' || n.type === 'ImageSpan';

/** Per-window element, content, clickable and text counts of a pruned layout. Pure. */
export function summarizeLayout(layout: DumpLayoutResult): LayoutSummary {
  const byWindow = new Map<string, LayoutWindowSummary>();
  const total = { elements: 0, content: 0, clickable: 0, text: 0 };
  for (const n of flattenLayout(layout.tree)) {
    const name = n.window ?? NO_WINDOW;
    let w = byWindow.get(name);
    if (!w) byWindow.set(name, (w = { window: name, elements: 0, content: 0, clickable: 0, text: 0 }));
    const add = (key: keyof typeof total, yes: boolean): void => {
      if (!yes) return;
      w![key]++;
      total[key]++;
    };
    add('elements', true);
    add('content', isContent(n));
    add('clickable', !!n.click);
    add('text', !!n.text);
  }
  return {
    display: layout.display,
    windows: [...byWindow.values()],
    total,
    ...(layout.keyboard ? { keyboard: layout.keyboard } : {}),
  };
}

/** How a baseline element was paired with a current one. */
export type LayoutMatchKind = 'id' | 'key' | 'text' | 'type';

/** The identifying fields of an element, as reported in a diff. */
export interface LayoutDiffNode {
  window?: string;
  type?: string;
  id?: string;
  key?: string;
  text?: string;
  desc?: string;
  hint?: string;
  /** Bounds as 0-1 fractions of the display. */
  b?: Box;
}

export interface LayoutMatch {
  by: LayoutMatchKind;
  baseline: LayoutDiffNode;
  current: LayoutDiffNode;
  /** Intersection over union of the two boxes (1 = same place and size). */
  iou: number;
  /** Fields whose value differs (`text`, `type`, `click`, `disabled`, `checked`, …). */
  changed: string[];
}

export interface LayoutDiff {
  /**
   * 0-1: the sum, over matched pairs, of their IoU (halved when a field
   * changed), divided by matched + missing + extra. 1 = the same layout.
   */
  similarity: number;
  matched: LayoutMatch[];
  /** Baseline elements with no counterpart now. */
  missing: LayoutDiffNode[];
  /** Current elements with no counterpart in the baseline. */
  extra: LayoutDiffNode[];
  /** Matched pairs that moved (IoU under 0.9) or changed a field. */
  moved: number;
  changed: number;
  counts: { baseline: number; current: number };
}

/** Matched pairs with an IoU under this are reported as moved. */
export const LAYOUT_MOVED_IOU = 0.9;

/** Intersection over union of two 0-1 boxes; 1 when neither has a box, 0 when only one has. */
export function boxIoU(a: Box | undefined, b: Box | undefined): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  if (union <= 0) return a.every((v, i) => v === b[i]) ? 1 : 0;
  return inter / union;
}

const COMPARED_FIELDS = ['type', 'text', 'desc', 'hint', 'click', 'check', 'checked', 'sel', 'disabled', 'covered', 'scroll'] as const;

function diffNode(n: FlatLayoutNode): LayoutDiffNode {
  const out: LayoutDiffNode = {};
  if (n.window !== undefined) out.window = n.window;
  if (n.type !== undefined) out.type = n.type;
  if (n.id !== undefined) out.id = n.id;
  if (n.key !== undefined) out.key = n.key;
  if (n.text !== undefined) out.text = n.text;
  if (n.desc !== undefined) out.desc = n.desc;
  if (n.hint !== undefined) out.hint = n.hint;
  if (n.b !== undefined) out.b = n.b;
  return out;
}

const label = (n: FlatLayoutNode): string | undefined => n.text ?? n.desc ?? n.hint;

/** Pairing rules, tried in order: a pair must share the window and the rule's identity. */
const RULES: ReadonlyArray<[LayoutMatchKind, (a: FlatLayoutNode, b: FlatLayoutNode) => boolean]> = [
  ['id', (a, b) => a.id !== undefined && a.id === b.id],
  ['key', (a, b) => a.key !== undefined && a.key === b.key],
  ['text', (a, b) => label(a) !== undefined && label(a) === label(b) && a.type === b.type],
  // Same type, and the boxes overlap: an element whose label changed.
  ['type', (a, b) => a.type !== undefined && a.type === b.type && boxIoU(a.b, b.b) > 0],
];

/** Accept a `dump layout` result, or a bare pruned tree. Throws on a `--raw` dump. */
export function parseLayoutBaseline(json: unknown): DumpLayoutResult {
  if (!json || typeof json !== 'object') throw new OniroError('The layout baseline is not a JSON object.');
  const obj = json as Partial<DumpLayoutResult>;
  const tree = (obj.tree ?? obj) as LayoutNode;
  if (typeof tree !== 'object' || tree === null) throw new OniroError('The layout baseline has no layout tree.');
  if ('attributes' in tree) {
    throw new OniroError('The layout baseline is a --raw dump; save it with `oniro-app dump layout` (pruned) instead.');
  }
  return { display: obj.display ?? null, tree, ...(obj.keyboard ? { keyboard: obj.keyboard } : {}) };
}

/**
 * Compare two pruned layouts. Elements are paired within the same window by
 * id, then key, then label (text, description or placeholder) and type, then
 * type with overlapping boxes; each rule pairs greedily by highest IoU. Boxes
 * are the dump's 0-1 fractions of the display, so layouts from screens of
 * different resolution compare. Pure.
 */
export function diffLayouts(baseline: DumpLayoutResult, current: DumpLayoutResult): LayoutDiff {
  const base = flattenLayout(baseline.tree);
  const cur = flattenLayout(current.tree);
  const freeBase = new Set(base.map((_, i) => i));
  const freeCur = new Set(cur.map((_, i) => i));
  const matched: LayoutMatch[] = [];

  for (const [by, same] of RULES) {
    const pairs: Array<{ i: number; j: number; iou: number }> = [];
    for (const i of freeBase) {
      for (const j of freeCur) {
        const a = base[i]!;
        const b = cur[j]!;
        if (a.window !== b.window || !same(a, b)) continue;
        pairs.push({ i, j, iou: boxIoU(a.b, b.b) });
      }
    }
    pairs.sort((p, q) => q.iou - p.iou || p.i - q.i || p.j - q.j);
    for (const { i, j, iou } of pairs) {
      if (!freeBase.has(i) || !freeCur.has(j)) continue;
      freeBase.delete(i);
      freeCur.delete(j);
      const a = base[i]!;
      const b = cur[j]!;
      const changed = COMPARED_FIELDS.filter((f) => (a[f] ?? null) !== (b[f] ?? null));
      matched.push({ by, baseline: diffNode(a), current: diffNode(b), iou: +iou.toFixed(3), changed });
    }
  }

  const missing = [...freeBase].sort((p, q) => p - q).map((i) => diffNode(base[i]!));
  const extra = [...freeCur].sort((p, q) => p - q).map((j) => diffNode(cur[j]!));
  const denominator = matched.length + missing.length + extra.length;
  const score = matched.reduce((s, m) => s + m.iou * (m.changed.length > 0 ? 0.5 : 1), 0);
  return {
    similarity: denominator === 0 ? 1 : +(score / denominator).toFixed(3),
    matched,
    missing,
    extra,
    moved: matched.filter((m) => m.iou < LAYOUT_MOVED_IOU).length,
    changed: matched.filter((m) => m.changed.length > 0).length,
    counts: { baseline: base.length, current: cur.length },
  };
}
