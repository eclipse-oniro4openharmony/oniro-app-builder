import { flattenLayout, type DumpLayoutResult, type FlatLayoutNode } from '@oniroproject/core';

const MAX_TEXT = 80;

function quote(s: string): string {
  return JSON.stringify(s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
}

function flags(n: FlatLayoutNode): string[] {
  const out: string[] = [];
  if (n.click) out.push('click');
  if (n.longClick) out.push('longClick');
  if (n.scroll) out.push('scroll');
  if (n.checked) out.push('checked');
  else if (n.check) out.push('checkable');
  if (n.sel) out.push('selected');
  if (n.focus) out.push('focus');
  if (n.disabled) out.push('disabled');
  if (n.covered) out.push('covered');
  return out;
}

/** One line per element: type, label, center (0–1 fractions), and state flags. */
export function formatLayoutLine(n: FlatLayoutNode): string {
  const parts: string[] = [n.type ?? 'node'];
  if (n.text !== undefined) parts.push(quote(n.text));
  if (n.desc !== undefined) parts.push(`desc=${quote(n.desc)}`);
  if (n.hint !== undefined) parts.push(`hint=${quote(n.hint)}`);
  if (n.id !== undefined) parts.push(`#${n.id}`);
  if (n.key !== undefined) parts.push(`key=${n.key}`);
  if (n.c) parts.push(`c=${n.c[0].toFixed(3)},${n.c[1].toFixed(3)}`);
  parts.push(...flags(n));
  return parts.join(' ');
}

/** Worth a line: it has a label to read or match, or it can be interacted with. */
function isListed(n: FlatLayoutNode): boolean {
  const labelled = n.text !== undefined || n.desc !== undefined || n.hint !== undefined;
  return labelled || !!(n.click || n.longClick || n.scroll || n.check || n.focus);
}

/**
 * Render a pruned layout as compact text for agents: a `[window <bundle>]`
 * header per window, then one line per labelled or interactive element in
 * paint order (decorative images and id-only wrappers are left to the JSON
 * output). The soft keyboard collapses to a single `[keyboard <bundle>]` line
 * instead of listing every key.
 */
export function formatFlatLayout(result: DumpLayoutResult): string {
  const lines: string[] = [];
  const d = result.display;
  lines.push(
    `# display ${d ? `${d.width}x${d.height}` : 'unknown'}; c = element center as 0-1 fractions ` +
      '(input --fx/--fy), or act by label with input --target "<text>"',
  );
  const keyboardBundle = result.keyboard?.shown ? result.keyboard.bundle : undefined;
  let window: string | undefined;
  for (const n of flattenLayout(result.tree)) {
    if (n.window !== window) {
      window = n.window;
      if (window !== undefined && window === keyboardBundle) {
        lines.push(`[keyboard ${window}] up — dismiss with input --type hideKeyboard`);
      } else if (window !== undefined) {
        lines.push(`[window ${window}]`);
      }
    }
    if (window !== undefined && window === keyboardBundle) continue;
    if (n.bundle !== undefined && n.text === undefined && !n.click) continue; // the window root itself
    if (isListed(n)) lines.push(formatLayoutLine(n));
  }
  return `${lines.join('\n')}\n`;
}
