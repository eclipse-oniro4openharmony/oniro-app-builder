import { Command, Option } from 'commander';
import {
  performInput,
  sendGesture,
  getDisplaySize,
  describeLayoutNode,
  type UiInputType,
  type Waypoint,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { addTargetOptions, selectorFrom, targetIndexFrom, type TargetOpts } from '../lib/target.js';

const INPUT_TYPES: UiInputType[] = [
  'click',
  'doubleClick',
  'longClick',
  'swipe',
  'drag',
  'fling',
  'keyEvent',
  'inputText',
  'clearText',
  'hideKeyboard',
];

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

interface InputOpts extends TargetOpts {
  type: UiInputType;
  x?: string;
  y?: string;
  x2?: string;
  y2?: string;
  fx?: string;
  fy?: string;
  fx2?: string;
  fy2?: string;
  speed?: string;
  key?: string;
  text?: string;
  clear?: boolean;
  hideKeyboard?: boolean;
  device?: string;
}

interface GestureOpts {
  waypoints: string;
  fractions?: boolean;
  holdStart?: string;
  holdEnd?: string;
  device?: string;
}

export function registerInputCommand(program: Command): void {
  const input = program
    .command('input')
    .description(
      'Inject a UI input event via uitest uiInput. Position it with --target (an on-screen element), ' +
        '--fx/--fy (0-1 fractions of the display, as in `dump layout` and the screenshot grid), or --x/--y (pixels).',
    )
    .addOption(new Option('--type <type>', 'Input type.').choices(INPUT_TYPES).makeOptionMandatory());
  addTargetOptions(input, 'Act on');
  input
    .option('--fx <fraction>', 'Start X as a 0-1 fraction of the display width.')
    .option('--fy <fraction>', 'Start Y as a 0-1 fraction of the display height.')
    .option('--fx2 <fraction>', 'End X fraction (swipe/drag/fling).')
    .option('--fy2 <fraction>', 'End Y fraction (swipe/drag/fling).')
    .option('--x <px>', 'X pixel (click/swipe start).')
    .option('--y <px>', 'Y pixel (click/swipe start).')
    .option('--x2 <px>', 'End X pixel (swipe/drag/fling).')
    .option('--y2 <px>', 'End Y pixel (swipe/drag/fling).')
    .option('--speed <px-per-s>', 'Velocity for swipe/drag/fling.')
    .option(
      '--key <key>',
      'Key for keyEvent: Back/Home/Power, a name (Delete, Enter, Tab, Escape, MoveHome, MoveEnd, …), ' +
        'a letter, a KeyCode id, or a combo like Ctrl+A.',
    )
    .option('--text <text>', 'Text for inputText.')
    .option('--clear', 'inputText: clear the field (Ctrl+A, Delete) before typing.')
    .option('--hide-keyboard', 'Dismiss the soft keyboard afterwards, if it is up.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: InputOpts) => {
      const { config, logger } = getRuntime();
      const result = await performInput({
        config,
        type: opts.type,
        target: selectorFrom(opts),
        targetIndex: targetIndexFrom(opts),
        fx: num(opts.fx),
        fy: num(opts.fy),
        fx2: num(opts.fx2),
        fy2: num(opts.fy2),
        pxX: num(opts.x),
        pxY: num(opts.y),
        pxX2: num(opts.x2),
        pxY2: num(opts.y2),
        speed: num(opts.speed),
        key: opts.key,
        text: opts.text,
        clear: opts.clear,
        hideKeyboard: opts.hideKeyboard,
        deviceSerial: opts.device,
        logger,
      });
      if (opts.type === 'hideKeyboard') {
        logger.info(result.keyboardHidden ? 'Dismissed the keyboard.' : 'The keyboard was not shown.');
        return;
      }
      const at = result.x !== undefined ? ` at ${result.x},${result.y}` : '';
      const on = result.target ? ` on ${describeLayoutNode(result.target)}` : '';
      const kb = result.keyboardHidden ? ' (dismissed the keyboard)' : '';
      logger.info(`Sent ${opts.type}${at}${on}${kb}.`);
    });

  program
    .command('gesture')
    .description('Inject a multi-waypoint gesture. Waypoints are JSON: [{"x":..,"y":..,"t":..}] in pixels (or fractions with --fractions).')
    .requiredOption('--waypoints <json>', 'JSON array of {x,y,t} waypoints (t = ms from start).')
    .option('--fractions', 'Waypoint x/y are 0-1 fractions of the display instead of pixels.')
    .option('--hold-start <ms>', 'Leading press-hold before moving (best-effort: uses `uitest drag`).')
    .option('--hold-end <ms>', 'Trailing hold before lifting (no uitest equivalent; ignored).')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: GestureOpts) => {
      const { config, logger } = getRuntime();
      let waypoints = JSON.parse(opts.waypoints) as Waypoint[];
      if (opts.fractions) {
        const bad = waypoints.find((w) => !(w.x >= 0 && w.x <= 1 && w.y >= 0 && w.y <= 1));
        if (bad) throw new Error(`With --fractions, waypoint x and y must be 0-1; got ${bad.x},${bad.y}.`);
        const display = await getDisplaySize(config, { deviceSerial: opts.device, logger });
        if (!display) throw new Error('Could not read the display size to convert fractions to pixels.');
        // 1.0 maps to the last pixel, not one past the edge.
        const px = (f: number, size: number): number => Math.min(size - 1, Math.round(f * size));
        waypoints = waypoints.map((w) => ({ ...w, x: px(w.x, display.width), y: px(w.y, display.height) }));
      }
      await sendGesture({
        config,
        waypoints,
        holdStartMs: num(opts.holdStart),
        holdEndMs: num(opts.holdEnd),
        deviceSerial: opts.device,
        logger,
      });
      logger.info('Gesture sent.');
    });
}
