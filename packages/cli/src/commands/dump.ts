import { Command } from 'commander';
import * as fs from 'node:fs';
import {
  diffLayouts,
  dumpLayout,
  findLayoutNodes,
  listWindows,
  parseLayoutBaseline,
  selectableTree,
  summarizeLayout,
  type WindowInfo,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { formatFlatLayout, formatSelectorMatches } from '../lib/layoutText.js';
import { SELECTOR_HELP, WINDOW_HELP, parseSelectorOption, windowIdFrom } from '../lib/target.js';

interface DumpOpts {
  bundle?: string;
  raw?: boolean;
  flat?: boolean;
  summary?: boolean;
  diff?: string;
  selector?: string;
  window?: string;
  json?: boolean;
  device?: string;
}

/** Read a `dump layout` JSON file saved earlier. */
function readBaseline(file: string): ReturnType<typeof parseLayoutBaseline> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read the layout baseline ${file}: ${(err as Error).message}`);
  }
  try {
    return parseLayoutBaseline(JSON.parse(text));
  } catch (err) {
    throw new Error(`${file} is not a saved \`dump layout\` JSON: ${(err as Error).message}`);
  }
}

function formatWindows(windows: WindowInfo[]): string {
  const lines = ['# id name pid type z-order [x y w h]; z-order -1 = not shown; `--window <id>` restricts dump/input/wait/screenshot'];
  for (const w of windows) {
    const rect = w.rect ? ` [${w.rect.join(' ')}]` : '';
    lines.push(`${w.id} ${w.name} pid=${w.pid} type=${w.type} z=${w.zOrder}${rect}${w.focused ? ' focused' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export function registerDumpCommand(program: Command): void {
  program
    .command('dump [target]')
    .description(
      'Dump device state. `dump layout` (the default target): JSON by default, or one line per element with --flat; ' +
        '--selector lists only the matching elements, --summary counts elements per window, --diff compares the live ' +
        'layout with one saved earlier. `dump windows`: the window list (ids for --window).',
    )
    .option('--bundle <bundle>', 'Filter the layout to a single window/bundle.')
    .option('--raw', 'Return the unpruned layout tree.')
    .option('--flat', 'One line per element (type, label, center as 0-1 fractions, flags) instead of a JSON tree.')
    .option('--summary', 'Per window: element, content, clickable and text-node counts (JSON).')
    .option(
      '--diff <baseline.json>',
      'Compare with a saved `dump layout` JSON: matched elements with IoU, missing, extra, and a 0-1 similarity (JSON).',
    )
    .option('--selector <expr>', `List only the elements matching this expression, numbered for its [n] suffix. ${SELECTOR_HELP}`)
    .option('--window <id>', WINDOW_HELP)
    .option('--json', 'dump windows: print JSON instead of one line per window.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (target: string | undefined, opts: DumpOpts) => {
      const { config, logger } = getRuntime();
      const what = target ?? 'layout';
      if (what === 'windows') {
        const windows = await listWindows({ config, deviceSerial: opts.device, logger });
        process.stdout.write(opts.json ? `${JSON.stringify(windows, null, 2)}\n` : formatWindows(windows));
        return;
      }
      if (what !== 'layout') throw new Error(`Unknown dump target "${what}". Supported: layout, windows.`);
      if (opts.raw && opts.flat) throw new Error('--raw and --flat cannot be combined.');
      const selector = parseSelectorOption(opts.selector);
      if (selector && opts.raw) throw new Error('--selector matches the pruned layout; it cannot be combined with --raw.');
      const modes = [opts.flat && '--flat', opts.summary && '--summary', opts.diff !== undefined && '--diff'].filter(Boolean);
      if (modes.length > 1) throw new Error(`${modes.join(' and ')} cannot be combined.`);
      if (opts.raw && modes.length > 0) throw new Error(`--raw cannot be combined with ${modes[0]}.`);
      if (selector && (opts.summary || opts.diff !== undefined)) {
        throw new Error(`--selector cannot be combined with ${opts.summary ? '--summary' : '--diff'}.`);
      }
      // Read the baseline before touching the device, so a bad path fails fast.
      const baseline = opts.diff !== undefined ? readBaseline(opts.diff) : undefined;
      const result = await dumpLayout({
        config,
        bundleName: opts.bundle,
        windowId: windowIdFrom(opts),
        prune: !opts.raw,
        detectKeyboard: !opts.raw,
        deviceSerial: opts.device,
        logger,
      });
      if (selector) {
        const matches = findLayoutNodes(selectableTree(result, windowIdFrom(opts)), selector);
        process.stdout.write(
          opts.flat
            ? formatSelectorMatches(result.display, selector.raw, matches)
            : `${JSON.stringify({ display: result.display, selector: selector.raw, matches }, null, 2)}\n`,
        );
        return;
      }
      let out: string;
      if (opts.flat) out = formatFlatLayout(result);
      else if (opts.summary) out = `${JSON.stringify(summarizeLayout(result), null, 2)}\n`;
      else if (baseline) {
        const diff = diffLayouts(baseline, result);
        logger.info(
          `layout similarity ${diff.similarity.toFixed(3)}: ${diff.matched.length} matched ` +
            `(${diff.moved} moved, ${diff.changed} changed), ${diff.missing.length} missing, ${diff.extra.length} extra.`,
        );
        out = `${JSON.stringify(diff, null, 2)}\n`;
      } else out = `${JSON.stringify(result, null, 2)}\n`;
      process.stdout.write(out);
    });
}
