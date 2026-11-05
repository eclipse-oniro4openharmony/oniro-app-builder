import type { Command } from 'commander';
import { parseSelector, type ElementQuery, type ElementSelector } from '@oniroproject/core';

/** The shared element-selector flags, as commander parses them. */
export interface TargetOpts {
  target?: string;
  targetId?: string;
  targetType?: string;
  targetIndex?: string;
  selector?: string;
  window?: string;
}

/** Help text for `--selector`, shared by every command that takes it. */
export const SELECTOR_HELP =
  'An attribute selector such as "type=Button,text*=Sign" (keys text, desc, hint, id, key, type, enabled, focused, ' +
  'checked, selected, visible, clickable, longClickable, checkable, scrollable; operators = *= ^= $= /=regex; ' +
  'a [n] suffix picks the n-th match, 0-based, [-1] or [last] the last), or "xpath=//Button[@text=\'OK\']".';

export const WINDOW_HELP =
  'Restrict to one window: a window id from `dump layout --flat` ([window <id> …]) or `dump windows`.';

/**
 * Add the element-selector flags shared by `input`, `wait`, and `screenshot`.
 * `verb` completes the `--target` help text (e.g. "Tap" → "Tap the element …").
 */
export function addTargetOptions(cmd: Command, verb: string, opts: { index?: boolean } = {}): Command {
  cmd
    .option(
      '--target <text>',
      `${verb} the element whose text, description, or placeholder matches ` +
        '(case-insensitive; exact matches win, else substring). Covered elements are skipped.',
    )
    .option('--target-id <id>', 'Match the element by its id or key.')
    .option('--target-type <type>', 'Restrict the match to a component type (e.g. Button, TextInput).');
  if (opts.index !== false) {
    cmd.option('--target-index <n>', 'Pick the n-th (0-based) of several matching elements.');
  }
  cmd.option('--selector <expr>', `Instead of --target*: ${SELECTOR_HELP}`).option('--window <id>', WINDOW_HELP);
  return cmd;
}

/** Parse `--selector` text; undefined when the flag is absent. */
export function parseSelectorOption(raw: string | undefined): ElementSelector | undefined {
  return raw === undefined ? undefined : parseSelector(raw);
}

/** The selector built from the flags, or undefined when none was given. */
export function selectorFrom(opts: TargetOpts): ElementQuery | undefined {
  const plain = opts.target !== undefined || opts.targetId !== undefined || opts.targetType !== undefined;
  if (opts.selector !== undefined) {
    if (plain) throw new Error('Use either --selector or --target / --target-id / --target-type, not both.');
    if (opts.targetIndex !== undefined) throw new Error('--target-index does not apply to --selector; append [n] to the selector.');
    return parseSelector(opts.selector);
  }
  if (!plain) return undefined;
  return { text: opts.target, id: opts.targetId, type: opts.targetType };
}

export function targetIndexFrom(opts: TargetOpts): number | undefined {
  if (opts.targetIndex === undefined) return undefined;
  const n = Number(opts.targetIndex);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--target-index must be a non-negative integer; got ${opts.targetIndex}.`);
  return n;
}

/** The `--window` id, or undefined when the flag is absent. */
export function windowIdFrom(opts: { window?: string }): number | undefined {
  if (opts.window === undefined) return undefined;
  const n = Number(opts.window);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--window must be a window id (a non-negative integer); got ${opts.window}.`);
  return n;
}
