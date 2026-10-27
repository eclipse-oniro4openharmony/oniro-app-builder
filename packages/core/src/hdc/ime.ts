import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { shell } from './exec.js';
import type { LayoutNode } from './dump.js';

/** System ability id of the input method service, for `hidumper -s`. */
const INPUT_METHOD_SA_ID = 3703;

// Used when hidumper can't list the installed input methods.
const IME_BUNDLE_FALLBACK = /inputmethod|keyboard|(^|\.)ime(\.|$)/i;

/**
 * Extract input-method bundle names from `hidumper -s 3703 -a -a` output, whose
 * `imeList` entries look like `"ime": "com.example.kikakeyboard/ServiceExtAbility"`.
 * The current IME comes first. Pure.
 */
export function parseImeBundles(output: string): string[] {
  const current: string[] = [];
  const others: string[] = [];
  const entry = /\{[^{}]*"ime"\s*:\s*"([^"/]+)\/[^"]*"[^{}]*\}/g;
  for (const m of output.matchAll(entry)) {
    const bundle = m[1]!;
    const list = /"isCurrentIme"\s*:\s*"true"/.test(m[0]) ? current : others;
    if (!current.includes(bundle) && !others.includes(bundle)) list.push(bundle);
  }
  return [...current, ...others];
}

/**
 * List the installed input-method bundles (current first). Empty when hidumper
 * fails or times out, so keyboard detection never fails the caller.
 */
export async function getImeBundles(
  config: ConfigProvider,
  opts: { deviceSerial?: string; logger?: Logger } = {},
): Promise<string[]> {
  try {
    const res = await shell({
      config,
      command: `hidumper -s ${INPUT_METHOD_SA_ID} -a '-a'`,
      deviceSerial: opts.deviceSerial,
      timeoutMs: 10_000,
      logger: opts.logger,
    });
    if (res.code === 0) return parseImeBundles(res.stdout);
  } catch (err) {
    opts.logger?.debug(`could not list input methods: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [];
}

/**
 * Find the input-method window in a pruned layout tree. uitest lists the soft
 * keyboard as its own window (a node carrying the IME's `bundle`) only while it
 * is shown. With no known IME bundles, falls back to a name heuristic. Pure.
 */
export function findKeyboardWindow(tree: LayoutNode, imeBundles: readonly string[]): LayoutNode | null {
  const isIme = (bundle: string): boolean =>
    imeBundles.length > 0 ? imeBundles.includes(bundle) : IME_BUNDLE_FALLBACK.test(bundle);
  const stack: LayoutNode[] = [tree];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.bundle && isIme(n.bundle)) return n;
    stack.push(...(n.children ?? []));
  }
  return null;
}
