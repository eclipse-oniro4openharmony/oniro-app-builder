import type { LayoutSelector } from '@oniroproject/core';
import type { JsonSchema } from './schema.js';

/**
 * The element-selector inputs shared by the `input`, `wait` and `screenshot`
 * tools: the MCP side of `--target`, `--target-id`, `--target-type` and
 * `--target-index` (src/lib/target.ts). A new selector input (such as a
 * `selector` expression string) is added here, in `targetProperties` and
 * `selectorFromArgs`, and every tool that takes a target gets it.
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
  };
  if (opts.index !== false) {
    props.targetIndex = { type: 'integer', minimum: 0, description: 'Pick the n-th (0-based) of several matching elements.' };
  }
  return props;
}

/** The selector built from the arguments, or undefined when none was given. */
export function selectorFromArgs(args: Record<string, unknown>): LayoutSelector | undefined {
  const text = args.target as string | undefined;
  const id = args.targetId as string | undefined;
  const type = args.targetType as string | undefined;
  if (text === undefined && id === undefined && type === undefined) return undefined;
  return { text, id, type };
}

export function targetIndexFromArgs(args: Record<string, unknown>): number | undefined {
  return args.targetIndex as number | undefined;
}
