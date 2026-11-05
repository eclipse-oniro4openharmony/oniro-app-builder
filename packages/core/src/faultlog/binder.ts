/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/faultlog/crash/binder-chain.ts`), Copyright (c) 2026
 * Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/faultlog/NOTICE.md.
 */
import { findSection } from './text.js';

/** `20020:20020 to 1234:5678 code 5f475352 wait:6.5 s frz_state:3,` */
const TRANS_RE =
  /(?<srcPid>\d+):(?<srcTid>\d+) to (?<dstPid>\d+):(?<dstTid>\d+) code (?<code>\S+) wait:(?<wait>[\d.]+) s(?: frz_state:(?<frz>\d+))?/;
/** Start of a peer's stack: `PeerBinder catcher stacktrace for pid : 1234`. */
const PEER_STACK_RE = /(?:catcher stacktrace for |Binder catcher stacktrace, type is \w+, )pid : (?<pid>\d+)/;

export interface BinderNode {
  pid: string;
  tid: string;
}

/** One binder transaction from the freeze log's BinderCatcher section. */
export interface BinderTransaction {
  srcPid: string;
  srcTid: string;
  dstPid: string;
  dstTid: string;
  code: string;
  waitSeconds: number;
  frzState: string;
  async: boolean;
  raw: string;
}

export interface BinderInfo {
  transactions: BinderTransaction[];
  /** pid → process name, from the peers' stacks. */
  peers: Map<string, string>;
}

/** One synchronous wait in the chain the faulting thread belongs to. */
export interface BinderEdge {
  /** `pid:tid(process/thread)`; a tid of 0 means every binder thread of the process is busy (IPC full). */
  from: string;
  to: string;
  waitSeconds: number;
  code: string;
  frzState?: string;
}

export interface BinderPropagation {
  /** Longest wait first. */
  edges: BinderTransaction[];
  /** Deadlock cycles, one representative per strongly connected group. */
  cycles: BinderNode[][];
  notes: string[];
}

const src = (t: BinderTransaction): BinderNode => ({ pid: t.srcPid, tid: t.srcTid });
const dst = (t: BinderTransaction): BinderNode => ({ pid: t.dstPid, tid: t.dstTid });
const key = (n: BinderNode): string => `${n.pid}:${n.tid}`;
const same = (a: BinderNode, b: BinderNode): boolean => a.pid === b.pid && a.tid === b.tid;

/** `pid:tid(process/thread)`; the main thread's name usually equals the process name, so it is shown once. */
export function nodeLabel(node: BinderNode, processNames: Map<string, string>, threadNames?: Map<string, string>): string {
  const parts: string[] = [];
  for (const part of [processNames.get(node.pid) ?? '', threadNames?.get(key(node)) ?? '']) {
    if (part && !parts.includes(part)) parts.push(part);
  }
  let label = key(node);
  if (parts.length > 0) label += `(${parts.join('/')})`;
  if (node.tid === '0') label += '(binder threads exhausted, IPC full)';
  return label;
}

/** Parse the BinderCatcher section: transactions, then the peers' stacks. */
export function parseBinder(lines: readonly string[]): BinderInfo {
  const info: BinderInfo = { transactions: [], peers: new Map() };
  // (?<!Peer) so a `PeerBinderCatcher --` line does not open the section.
  const [section] = findSection(lines, /(?<!Peer)BinderCatcher --/, /end time:|^-{5,}\s*$/);
  let peerStart = section.length;
  for (let i = 0; i < section.length; i++) {
    const line = section[i]!;
    if (line.includes('PeerBinder Stacktrace') || PEER_STACK_RE.test(line)) {
      peerStart = i;
      break;
    }
    const g = TRANS_RE.exec(line)?.groups;
    if (g) {
      info.transactions.push({
        srcPid: g.srcPid!, srcTid: g.srcTid!, dstPid: g.dstPid!, dstTid: g.dstTid!, code: g.code!,
        waitSeconds: Number.parseFloat(g.wait!), frzState: g.frz ?? '', async: line.trimStart().startsWith('async'), raw: line.trim(),
      });
    }
  }
  const peerLines = section.slice(peerStart);
  const starts: Array<{ index: number; pid: string }> = [];
  peerLines.forEach((line, index) => {
    const pid = PEER_STACK_RE.exec(line)?.groups?.pid;
    if (pid) starts.push({ index, pid });
  });
  starts.forEach((start, order) => {
    const chunk = peerLines.slice(start.index, starts[order + 1]?.index ?? peerLines.length).join('\n');
    info.peers.set(start.pid, /Process name:(.*)/.exec(chunk)?.[1]?.trim() ?? '');
  });
  return info;
}

/** A tid of 0 on the node stands for any binder thread of the process. */
function next(t: BinderTransaction, node: BinderNode, forward: boolean): BinderNode | null {
  if (forward) return t.srcPid === node.pid && (t.srcTid === node.tid || node.tid === '0') ? dst(t) : null;
  // Toward the waiter: a destination tid of 0 (IPC full) matches the whole process.
  return t.dstPid === node.pid && (t.dstTid === node.tid || t.dstTid === '0') ? src(t) : null;
}

function walk(sync: BinderTransaction[], starts: BinderNode[], forward: boolean): BinderTransaction[] {
  const visited = new Set(starts.map(key));
  const stack = [...starts];
  const edges: BinderTransaction[] = [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const t of sync) {
      const n = next(t, node, forward);
      if (!n) continue;
      if (!edges.includes(t)) edges.push(t);
      if (!visited.has(key(n))) {
        visited.add(key(n));
        stack.push(n);
      }
    }
  }
  return edges;
}

/**
 * The synchronous binder chain the faulting thread is part of: what it waits on
 * (downstream) and who waits on it (upstream), anchored on every thread of the
 * faulting process that appears in a transaction, plus any deadlock cycles.
 */
export function buildPropagation(binder: BinderInfo, faultPid: string, faultTid: string): BinderPropagation {
  const sync = binder.transactions.filter((t) => !t.async);
  const anchor: BinderNode[] = [{ pid: faultPid, tid: faultTid }];
  for (const t of sync) {
    for (const node of [src(t), dst(t)]) {
      if (node.pid === faultPid && !anchor.some((a) => same(a, node))) anchor.push(node);
    }
  }
  const seen = new Set<string>();
  const edges = [...walk(sync, anchor, true), ...walk(sync, anchor, false)].filter((t) => !seen.has(t.raw) && seen.add(t.raw));
  if (edges.length === 0) {
    return { edges: [], cycles: [], notes: ['The faulting process was in no synchronous binder call; the thread was not blocked on IPC.'] };
  }
  const notes = edges.some((t) => t.dstTid === '0')
    ? ['A call in the chain targets tid 0: that process had no free binder thread (IPC full).']
    : [];
  return { edges: [...edges].sort((a, b) => b.waitSeconds - a.waitSeconds), cycles: findCycles(edges), notes };
}

interface Graph {
  out: Map<string, BinderNode[]>;
  in: Map<string, BinderNode[]>;
  nodes: Map<string, BinderNode>;
}

function buildGraph(edges: BinderTransaction[]): Graph {
  const g: Graph = { out: new Map(), in: new Map(), nodes: new Map() };
  for (const e of edges) {
    const a = src(e);
    const b = dst(e);
    g.nodes.set(key(a), a);
    g.nodes.set(key(b), b);
    g.out.set(key(a), [...(g.out.get(key(a)) ?? []), b]);
    g.in.set(key(b), [...(g.in.get(key(b)) ?? []), a]);
  }
  return g;
}

/** Kosaraju, first pass: finish order of an iterative DFS. */
function finishOrder(g: Graph): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of g.out.keys()) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ key: string; next: number }> = [{ key: start, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const neighbor = (g.out.get(top.key) ?? [])[top.next];
      if (!neighbor) {
        order.push(top.key);
        stack.pop();
        continue;
      }
      top.next += 1;
      const k = key(neighbor);
      if (!visited.has(k) && g.out.has(k)) {
        visited.add(k);
        stack.push({ key: k, next: 0 });
      }
    }
  }
  return order;
}

/** Kosaraju, second pass: strongly connected groups on the reversed graph. */
function groups(g: Graph, order: string[]): BinderNode[][] {
  const assigned = new Set<string>();
  const out: BinderNode[][] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i]!;
    if (assigned.has(root)) continue;
    assigned.add(root);
    const keys = [root];
    for (let h = 0; h < keys.length; h++) {
      for (const prev of g.in.get(keys[h]!) ?? []) {
        const k = key(prev);
        if (!assigned.has(k) && g.out.has(k)) {
          assigned.add(k);
          keys.push(k);
        }
      }
    }
    out.push(keys.map((k) => g.nodes.get(k)!).filter(Boolean));
  }
  return out;
}

/** The shortest cycle back to `start` (BFS), or null. */
function cycleFrom(start: BinderNode, g: Graph): BinderNode[] | null {
  const parent = new Map<string, BinderNode>();
  const seen = new Set([key(start)]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const n of g.out.get(key(node)) ?? []) {
      if (same(n, start)) {
        const path: BinderNode[] = [];
        let cursor: BinderNode | undefined = node;
        while (cursor && !same(cursor, start)) {
          path.push(cursor);
          cursor = parent.get(key(cursor));
        }
        return cursor ? [start, ...path.reverse()] : null;
      }
      const k = key(n);
      if (!seen.has(k) && g.out.has(k)) {
        seen.add(k);
        parent.set(k, node);
        queue.push(n);
      }
    }
  }
  return null;
}

/** One representative cycle per strongly connected group: enumerating every cycle of a dense graph is exponential. */
function findCycles(edges: BinderTransaction[]): BinderNode[][] {
  const g = buildGraph(edges);
  return groups(g, finishOrder(g))
    .map((group) => (group[0] ? cycleFrom(group[0], g) : null))
    .filter((cycle): cycle is BinderNode[] => cycle !== null && cycle.length > 0);
}
