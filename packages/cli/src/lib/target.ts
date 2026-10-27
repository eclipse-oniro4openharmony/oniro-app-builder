import type { Command } from 'commander';
import type { LayoutSelector } from '@oniroproject/core';

/** The shared element-selector flags, as commander parses them. */
export interface TargetOpts {
  target?: string;
  targetId?: string;
  targetType?: string;
  targetIndex?: string;
}

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
  return cmd;
}

/** The selector built from the flags, or undefined when none was given. */
export function selectorFrom(opts: TargetOpts): LayoutSelector | undefined {
  if (opts.target === undefined && opts.targetId === undefined && opts.targetType === undefined) return undefined;
  return { text: opts.target, id: opts.targetId, type: opts.targetType };
}

export function targetIndexFrom(opts: TargetOpts): number | undefined {
  if (opts.targetIndex === undefined) return undefined;
  const n = Number(opts.targetIndex);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--target-index must be a non-negative integer; got ${opts.targetIndex}.`);
  return n;
}
