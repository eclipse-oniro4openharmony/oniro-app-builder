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
  children?: LayoutNode[];
}

export interface DumpLayoutResult {
  display: DisplaySize | null;
  tree: LayoutNode;
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

/**
 * Prune a raw `uitest dumpLayout` tree into a compact, signal-bearing tree with
 * bounds/center normalized to 0–1 of the display. Structural wrapper nodes with
 * no signal collapse into their children. Returns a node, a flat list of nodes
 * (collapsed wrapper with multiple children), or null (nothing useful). Ported
 * verbatim from the proven MCP `pruneNode`.
 */
export function pruneLayout(node: RawLayoutNode, display: DisplaySize | null): LayoutNode | LayoutNode[] | null {
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
  if (a.id) out.id = a.id;
  if (a.key && a.key !== a.id) out.key = a.key;
  if (a.bundleName) out.bundle = a.bundleName;
  for (const [attr, short] of FLAG_MAP) {
    if (a[attr] === 'true') (out[short] as boolean) = true;
  }

  const children: LayoutNode[] = [];
  for (const c of node.children ?? []) {
    const pc = pruneLayout(c, display);
    if (pc) {
      if (Array.isArray(pc)) children.push(...pc);
      else children.push(pc);
    }
  }

  const hasSignal = Boolean(
    out.text || out.desc || out.id || out.key || out.click ||
      out.scroll || out.check || out.longClick || out.bundle ||
      (out.type && out.type !== 'root'),
  );

  if (!hasSignal && children.length === 0) return null;
  // Collapse structural wrappers: pass children up to the parent.
  if (!hasSignal) return children.length === 1 ? children[0]! : children;

  if (children.length) out.children = children;
  return out;
}

export interface DumpLayoutOptions {
  config: ConfigProvider;
  /** Filter to a single window/bundle (`uitest dumpLayout -b '<bundle>'`). */
  bundleName?: string;
  /** When false, return the parsed-but-unpruned tree. Default true. */
  prune?: boolean;
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
    const prunedRaw = pruneLayout(parsed, display);
    const tree: LayoutNode = Array.isArray(prunedRaw) ? { children: prunedRaw } : prunedRaw ?? { children: [] };
    return { display, tree };
  } finally {
    fs.promises.unlink(local).catch(() => {});
    void shell({ config: opts.config, command: `rm -f ${remote}`, deviceSerial: opts.deviceSerial }).catch(() => {});
  }
}
