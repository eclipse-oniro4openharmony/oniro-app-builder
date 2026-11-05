import type { ElementQuery } from '@oniroproject/core';
import { selectorFrom, windowIdFrom } from '../lib/target.js';
import type { JsonSchema } from './schema.js';

/**
 * The element-selector inputs shared by the `input`, `wait`, `screenshot` and
 * `dump_layout` tools: the MCP side of `--target`, `--target-id`,
 * `--target-type`, `--target-index`, `--selector` and `--window`
 * (src/lib/target.ts), checked by the same rules.
 */
export function targetProperties(verb: string, opts: { index?: boolean } = {}): Record<string, JsonSchema> {
  const props: Record<string, JsonSchema> = {
    target: {
      type: 'string',
      description:
        `${verb} the element whose text, description, or placeholder matches ` +
        '(case-insensitive; exact matches win, else substring). Covered elements are skipped.',
    },
    targetId: { type: 'string', description: 'Match the element by its id or key.' },
    targetType: { type: 'string', description: 'Restrict the match to a component type (e.g. Button, TextInput).' },
    selector: {
      type: 'string',
      description:
        'Instead of target*: an exact selector. Attributes as comma-separated key<op>value clauses ' +
        '(keys text, desc, hint, id, key, type, enabled, focused, checked, selected, visible, clickable, scrollable; ' +
        'ops = *= ^= $= /=regex) with an optional [n] index, e.g. "type=Button,text*=Sign[1]"; or ' +
        '"xpath=//Button[@text=\\"OK\\"]".',
    },
    window: windowProperty,
  };
  if (opts.index !== false) {
    props.targetIndex = { type: 'integer', minimum: 0, description: 'Pick the n-th (0-based) of several matching elements.' };
  }
  return props;
}

/** The `window` input on its own, for tools that take a window but no element. */
export const windowProperty: JsonSchema = {
  type: 'integer',
  minimum: 0,
  description: 'Only this window (an id from `dump windows`, or the [window <id> ...] header of a flat dump).',
};

/** The element query built from the arguments, or undefined when none was given. */
export function selectorFromArgs(args: Record<string, unknown>): ElementQuery | undefined {
  return selectorFrom({
    target: args.target as string | undefined,
    targetId: args.targetId as string | undefined,
    targetType: args.targetType as string | undefined,
    targetIndex: args.targetIndex === undefined ? undefined : String(args.targetIndex),
    selector: args.selector as string | undefined,
  });
}

export function targetIndexFromArgs(args: Record<string, unknown>): number | undefined {
  return args.targetIndex as number | undefined;
}

export function windowFromArgs(args: Record<string, unknown>): number | undefined {
  return windowIdFrom({ window: args.window === undefined ? undefined : String(args.window) });
}
