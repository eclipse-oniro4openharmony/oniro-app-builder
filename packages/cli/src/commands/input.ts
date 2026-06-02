import { Command, Option } from 'commander';
import { sendInput, sendGesture, type InputType, type Waypoint } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

const INPUT_TYPES: InputType[] = ['click', 'doubleClick', 'longClick', 'swipe', 'drag', 'fling', 'keyEvent', 'inputText'];

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

interface InputOpts {
  type: InputType;
  x?: string;
  y?: string;
  x2?: string;
  y2?: string;
  speed?: string;
  key?: string;
  text?: string;
  device?: string;
}

interface GestureOpts {
  waypoints: string;
  holdStart?: string;
  holdEnd?: string;
  device?: string;
}

export function registerInputCommand(program: Command): void {
  program
    .command('input')
    .description('Inject a UI input event (pixel coordinates) via uitest uiInput.')
    .addOption(new Option('--type <type>', 'Input type.').choices(INPUT_TYPES).makeOptionMandatory())
    .option('--x <px>', 'X pixel (click/swipe start).')
    .option('--y <px>', 'Y pixel (click/swipe start).')
    .option('--x2 <px>', 'End X pixel (swipe/drag/fling).')
    .option('--y2 <px>', 'End Y pixel (swipe/drag/fling).')
    .option('--speed <px-per-s>', 'Velocity for swipe/drag/fling.')
    .option('--key <key>', 'Key id or symbolic name (Back/Home/Power) for keyEvent.')
    .option('--text <text>', 'Text for inputText.')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: InputOpts) => {
      const { config, logger } = getRuntime();
      await sendInput({
        config,
        type: opts.type,
        pxX: num(opts.x),
        pxY: num(opts.y),
        pxX2: num(opts.x2),
        pxY2: num(opts.y2),
        speed: num(opts.speed),
        key: opts.key,
        text: opts.text,
        deviceSerial: opts.device,
        logger,
      });
      logger.info(`Sent ${opts.type}.`);
    });

  program
    .command('gesture')
    .description('Inject a multi-waypoint gesture. Waypoints are pixel JSON: [{"x":..,"y":..,"t":..}].')
    .requiredOption('--waypoints <json>', 'JSON array of {x,y,t} pixel waypoints (t = ms from start).')
    .option('--hold-start <ms>', 'Leading press-hold before moving (best-effort: uses `uitest drag`).')
    .option('--hold-end <ms>', 'Trailing hold before lifting (no uitest equivalent; ignored).')
    .option('--device <serial>', 'Target device serial.')
    .action(async (opts: GestureOpts) => {
      const { config, logger } = getRuntime();
      const waypoints = JSON.parse(opts.waypoints) as Waypoint[];
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
