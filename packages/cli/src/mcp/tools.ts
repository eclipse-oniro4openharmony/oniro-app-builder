import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeFaultLog,
  captureBurst,
  describeLayoutNode,
  diffLayouts,
  dumpLayout,
  inventoryScreens,
  latestCrash,
  locateTarget,
  parseLayoutBaseline,
  performInput,
  runDoctor,
  runTests,
  summarizeLayout,
  takeScreenshot,
  waitForBoot,
  waitForBundle,
  waitForLog,
  waitForTarget,
  DEFAULT_SMOKE_DELAY_MS,
  type CrashVerdict,
  type DumpLayoutResult,
  type UiInputType,
} from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';
import { runBuild } from '../commands/build.js';
import { arktsCheckExitCode, arktsCheckOrError } from '../commands/check.js';
import { testExitCode } from '../commands/test.js';
import { applyWithSmoke, launchWithSmoke } from '../commands/app.js';
import { runApiSearch, runApiShow } from '../commands/api.js';
import { doctorExitCode } from '../commands/doctor.js';
import { devicesJson, queryDevices } from '../commands/devices.js';
import { formatFlatLayout } from '../lib/layoutText.js';
import { parseCrashSince, projectBundle } from '../lib/crashReport.js';
import { parseSince } from '../lib/logSince.js';
import {
  buildContactSheet,
  cropImage,
  diffScreenshots,
  frameDiffs,
  padCropRect,
  parseCropRect,
  renderWithGrid,
  type CropRect,
} from '../lib/screenshotImage.js';
import type { McpTool, ToolContent, ToolResult } from './protocol.js';
import type { JsonSchema } from './schema.js';
import { selectorFromArgs, targetIndexFromArgs, targetProperties } from './target.js';

/** What every tool call knows besides its arguments: the server's `--project` and `--device`. */
export interface ToolContext {
  projectDir: string;
  deviceSerial?: string;
}

type Args = Record<string, unknown>;
type Tool = McpTool<ToolContext>;

// ---- schema helpers -------------------------------------------------------

const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra });
const bool = (description: string, dflt?: boolean): JsonSchema => ({
  type: 'boolean',
  description,
  ...(dflt !== undefined ? { default: dflt } : {}),
});
const num = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'number', description, ...extra });
const int = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'integer', description, ...extra });

const PROJECT: Record<string, JsonSchema> = {
  project: str("Project directory; a relative path resolves against the server's --project (default: the server's --project)."),
};
const DEVICE: Record<string, JsonSchema> = {
  device: str("Target device serial (default: the server's --device, else the only connected device)."),
};

function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema & { type: 'object' } {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

// ---- argument helpers ------------------------------------------------------

function projectOf(a: Args, ctx: ToolContext): string {
  return typeof a.project === 'string' ? path.resolve(ctx.projectDir, a.project) : ctx.projectDir;
}

function deviceOf(a: Args, ctx: ToolContext): string | undefined {
  return (a.device as string | undefined) ?? ctx.deviceSerial;
}

/** A path argument: relative paths resolve against the project of the call. */
function pathArg(a: Args, key: string, ctx: ToolContext): string | undefined {
  const v = a[key];
  return typeof v === 'string' ? path.resolve(projectOf(a, ctx), v) : undefined;
}

// ---- result helpers --------------------------------------------------------

/** The command's `--json` object as structured content, and the same JSON as the text block. */
function jsonResult(json: Record<string, unknown>, isError = false, extra: ToolContent[] = []): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(json) }, ...extra],
    structuredContent: json,
    ...(isError ? { isError: true } : {}),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jpeg(buf: Buffer): ToolContent {
  return { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' };
}

function rt(): { config: ReturnType<typeof getRuntime>['config']; logger: ReturnType<typeof getRuntime>['logger'] } {
  const { config, logger } = getRuntime();
  return { config, logger };
}

const SMOKE: Record<string, JsonSchema> = {
  smoke: bool(
    'After launch, wait for the process, take a screenshot after smokeDelay, and fail (isError) when the process ' +
      'died or the screen is blank; a crash is reported from the faultlog.',
    false,
  ),
  smokeDelay: int('With smoke: wait between the process appearing and the screenshot, ms.', {
    minimum: 0,
    default: DEFAULT_SMOKE_DELAY_MS,
  }),
  smokeScreenshot: str('With smoke: where to write the screenshot (default: a file in the system temp dir).'),
};

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

// ---- tools -----------------------------------------------------------------

const build: Tool = {
  name: 'build',
  title: 'Build the app',
  description:
    'Build an OpenHarmony or HarmonyOS app via hvigorw (`oniro-app build --json`). Returns ok, exitCode, durationMs, ' +
    'failedTask, diagnostics (severity, source, code, rule, message, file, line, column, task), summary, discoveredHaps, ' +
    'warnings, error and rawTail. An OpenHarmony project fails early, naming the release to install, when the SDK for ' +
    'its compileSdkVersion is missing. isError when the build fails.',
  inputSchema: object({
    ...PROJECT,
    product: str('hvigor product name.', { default: 'default' }),
    module: str('Restrict the build to a specific module.'),
    mode: str('hvigor build mode (e.g. release, debug).'),
    task: str('hvigor task to run.', { default: 'assembleHap' }),
    deps: bool('Run `ohpm install --all` when oh_modules/ is missing (false = --no-deps).', true),
    parallel: bool('Build modules in parallel (false = --no-parallel).', true),
    installSdk: bool('Install the OpenHarmony SDK the project compiles against when it is missing, then build.', false),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    try {
      const report = await runBuild(projectOf(a, ctx), {
        product: a.product as string,
        module: a.module as string | undefined,
        mode: a.mode as string | undefined,
        task: a.task as string,
        deps: a.deps as boolean,
        parallel: a.parallel as boolean,
        installSdk: a.installSdk as boolean,
      });
      return jsonResult(report as unknown as Args, !report.ok);
    } catch (err) {
      // The build could not run at all: the object `build --json` prints then.
      return jsonResult({ ok: false, exitCode: 1, error: message(err), diagnostics: [] }, true);
    }
  },
};

const checkArktsTool: Tool = {
  name: 'check_arkts',
  title: 'Check ArkTS',
  description:
    "Type-check and lint ArkTS with the SDK's own ArkTS checker (what the build's CompileArkTS runs), plus the ArkUI " +
    'component-model and project-config rules the build enforces later (V1/V2 decorators, @Entry root, route maps, ' +
    'resources, permissions), in seconds and without a build (`oniro-app check arkts --json`). Returns ok, completed, ' +
    'diagnostics (severity, source, rule, message, file, line, column), fixed, alsoModified, summary, sdk, durationMs, ' +
    'error. isError when it found an error or could not run (completed: false means nothing is known).',
  inputSchema: object({
    ...PROJECT,
    files: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Check only these .ets files (project-wide rules such as main_pages.json and module.json5 are then skipped).',
    },
    fix: bool(
      "Apply the fixes the checker can verify (the compiler's `Did you mean` suggestions, import paths, a missing " +
        '`export`, the @Component/@ComponentV2 decorator), re-check, and revert any fix that adds an error.',
      false,
    ),
    sdk: str('SDK directory to check against (holding ets/), instead of the one compileSdkVersion names.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    const report = await arktsCheckOrError(projectOf(a, ctx), {
      files: a.files as string[] | undefined,
      fix: a.fix as boolean,
      sdk: pathArg(a, 'sdk', ctx),
    });
    return jsonResult(report as unknown as Args, arktsCheckExitCode(report) !== 0);
  },
};

const test: Tool = {
  name: 'test',
  title: 'Run the ohosTest suite',
  description:
    "Build a module's main and ohosTest HAPs, install both on the device, run the suite with `aa test` (Hypium) and " +
    'report each case (`oniro-app test --json`). Returns ok, outcome, tests (suite, name, status, statusCode, durationMs, ' +
    'message, stack), summary, resultCode, haps, log, error. isError when a case failed or the run did not complete. ' +
    'Installs on the device; the test module is left installed.',
  inputSchema: object({
    ...PROJECT,
    module: str('Module whose src/ohosTest suite runs.', { default: 'entry' }),
    product: str('hvigor product name.', { default: 'default' }),
    class: str('Run only these cases: `Suite`, `Suite#case`, or several joined by commas.'),
    timeout: int('Per-case timeout passed to the runner, ms.', { minimum: 1, default: 15_000 }),
    runTimeout: int('Wall-clock limit for the whole run, ms; aa test can hang when the app dies.', { minimum: 1, default: 600_000 }),
    build: bool('Build the HAPs first (false = --no-build: use the HAPs already built).', true),
    wake: bool(
      'Turn the screen on, swipe a credential-less lock screen away and keep it on during the run (false = --no-wake).',
      true,
    ),
    mode: str('hvigor build mode (e.g. debug).'),
    deps: bool('Run `ohpm install --all` when oh_modules/ is missing (false = --no-deps).', true),
    ...DEVICE,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  changesDevice: true,
  async call(a, ctx) {
    const { config, logger } = rt();
    const report = await runTests({
      config,
      projectDir: projectOf(a, ctx),
      module: a.module as string,
      product: a.product as string,
      testClass: a.class as string | undefined,
      caseTimeoutMs: a.timeout as number,
      runTimeoutMs: a.runTimeout as number,
      build: a.build as boolean,
      wakeScreen: a.wake as boolean,
      mode: a.mode as string | undefined,
      autoInstallDeps: a.deps as boolean,
      deviceSerial: deviceOf(a, ctx),
      logger,
    });
    return jsonResult(report as unknown as Args, testExitCode(report) !== 0);
  },
};

const apply: Tool = {
  name: 'apply',
  title: 'Install and apply a HAP',
  description:
    'Install the HAP of the project (or `hap`) and verify the running process took the change (`oniro-app app apply ' +
    '--json`). Refuses a HAP of another bundle. Handles sign-info mismatch, asset-cache invalidation, and ' +
    'persistent-bundle restart. Returns method, preInstallPid, postInstallPid, replaced, cacheCleared, and with smoke a ' +
    '`smoke` verdict (passed, failures, pid, alive, blankScreen, blankScore, crash, screenshot). isError when the smoke ' +
    'check fails.',
  inputSchema: object({
    ...PROJECT,
    hap: str(
      'An explicit .hap file (relative to the project); its own bundleName is the one applied unless `bundle` is given.',
    ),
    bundle: str('Bundle name to apply changes to. Defaults to the bundleName in the .hap file, else in the project AppScope/app.json5.'),
    module: str('Module to resolve the HAP from (multi-module projects).'),
    installedHap: str('Local path to the currently-installed HAP, to enable the asset-cache reboot.'),
    system: bool('Treat as a persistent/system bundle (refuses uninstall on sign-info mismatch).', false),
    allowUninstall: bool('Permit uninstalling a system bundle on sign-info mismatch (dangerous).', false),
    ...SMOKE,
    ...DEVICE,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  changesDevice: true,
  async call(a, ctx) {
    const hap = pathArg(a, 'hap', ctx);
    const report = await applyWithSmoke(rt(), {
      // A HAP goes in as the command's positional .hap, so its own bundle name is the one applied.
      target: hap ?? projectOf(a, ctx),
      bundle: a.bundle as string | undefined,
      module: a.module as string | undefined,
      installedHap: pathArg(a, 'installedHap', ctx),
      system: a.system as boolean,
      allowUninstall: a.allowUninstall as boolean,
      smoke: a.smoke as boolean,
      smokeDelay: a.smokeDelay as number,
      smokeScreenshot: pathArg(a, 'smokeScreenshot', ctx),
      device: deviceOf(a, ctx),
    });
    return jsonResult(report as unknown as Args, report.smoke ? !report.smoke.passed : false);
  },
};

const launch: Tool = {
  name: 'launch',
  title: 'Launch the app',
  description:
    'Launch an app on the device (`oniro-app app launch --json`). Project mode (default) resolves the bundle and main ' +
    'ability from the project; bundle mode (`bundle`) launches an already-installed app. With smoke, waits for the ' +
    'process, takes a screenshot and reports whether it died, crashed (from the faultlog) or shows a blank screen. ' +
    'Returns bundle and, with smoke, `smoke` (passed, failures, pid, alive, blankScreen, blankScore, crash, screenshot). ' +
    'isError when the smoke check fails.',
  inputSchema: object({
    ...PROJECT,
    bundle: str('Launch an already-installed app by bundle name (no project needed).'),
    module: str('Module folder name (project mode).', { default: 'entry' }),
    ability: str(
      'Explicit ability to launch (defaults to the module mainElement in project mode, or the installed bundle main ability in bundle mode).',
    ),
    ...SMOKE,
    ...DEVICE,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  changesDevice: true,
  async call(a, ctx) {
    const report = await launchWithSmoke(rt(), {
      projectDir: projectOf(a, ctx),
      bundle: a.bundle as string | undefined,
      module: a.module as string,
      ability: a.ability as string | undefined,
      smoke: a.smoke as boolean,
      smokeDelay: a.smokeDelay as number,
      smokeScreenshot: pathArg(a, 'smokeScreenshot', ctx),
      device: deviceOf(a, ctx),
    });
    return jsonResult(report as unknown as Args, report.smoke ? !report.smoke.passed : false);
  },
};

/** A `dump layout` JSON saved earlier, for `diff`. */
function readLayoutBaseline(file: string): DumpLayoutResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read the layout baseline ${file}: ${message(err)}`);
  }
  try {
    return parseLayoutBaseline(JSON.parse(text));
  } catch (err) {
    throw new Error(`${file} is not a saved \`dump layout\` JSON: ${message(err)}`);
  }
}

const dumpLayoutTool: Tool = {
  name: 'dump_layout',
  title: 'Dump the UI layout',
  description:
    'Dump the on-screen UI layout (`oniro-app dump layout`). Default: the pruned JSON tree (large; prefer flat or ' +
    'summary). flat: one line per labelled or interactive element (type, label, center as 0-1 fractions, flags), as ' +
    'text. summary: per window element, content, clickable and text-node counts. diff: compare with a layout saved ' +
    'earlier (via `output`): matched elements with IoU, missing, extra, and a 0-1 similarity.',
  inputSchema: object({
    bundle: str('Filter the layout to a single window/bundle.'),
    raw: bool('Return the unpruned layout tree.', false),
    flat: bool('One line per element (type, label, center as 0-1 fractions, flags) instead of a JSON tree.', false),
    summary: bool('Per window: element, content, clickable and text-node counts (JSON).', false),
    diff: str(
      'Compare with a saved `dump layout` JSON (relative to the project): matched elements with IoU, missing, extra, and a 0-1 similarity (JSON).',
    ),
    output: str('Also write what is returned (the JSON, or the flat text) to this file, e.g. as a later diff baseline.'),
    ...PROJECT,
    ...DEVICE,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    const { config, logger } = rt();
    if (a.raw && a.flat) throw new Error('raw and flat cannot be combined.');
    const modes = [a.flat && 'flat', a.summary && 'summary', a.diff !== undefined && 'diff'].filter(Boolean);
    if (modes.length > 1) throw new Error(`${modes.join(' and ')} cannot be combined.`);
    if (a.raw && modes.length > 0) throw new Error(`raw cannot be combined with ${modes[0]}.`);
    const diffPath = pathArg(a, 'diff', ctx);
    // Read the baseline before touching the device, so a bad path fails fast.
    const baseline = diffPath !== undefined ? readLayoutBaseline(diffPath) : undefined;
    const result = await dumpLayout({
      config,
      bundleName: a.bundle as string | undefined,
      prune: !a.raw,
      detectKeyboard: !a.raw,
      deviceSerial: deviceOf(a, ctx),
      logger,
    });
    const output = pathArg(a, 'output', ctx);
    if (a.flat) {
      const text = formatFlatLayout(result);
      if (output) fs.writeFileSync(output, text);
      return { content: [{ type: 'text', text }] };
    }
    let json: Args;
    if (a.summary) json = summarizeLayout(result) as unknown as Args;
    else if (baseline) json = diffLayouts(baseline, result) as unknown as Args;
    else json = result as unknown as Args;
    if (output) fs.writeFileSync(output, `${JSON.stringify(json, null, 2)}\n`);
    return jsonResult(json);
  },
};

const input: Tool = {
  name: 'input',
  title: 'Send a UI input',
  description:
    'Inject a UI input event via uitest uiInput (`oniro-app input`). Position it with target/targetId/targetType (an ' +
    'on-screen element), fx/fy (0-1 fractions of the display, as in dump_layout flat and the screenshot grid), or x/y ' +
    '(pixels). Returns x, y (the resolved start point in pixels), target (the element it resolved to) and keyboardHidden.',
  inputSchema: object(
    {
      type: { type: 'string', enum: INPUT_TYPES, description: 'Input type.' },
      ...targetProperties('Act on'),
      fx: num('Start X as a 0-1 fraction of the display width.', { minimum: 0, maximum: 1 }),
      fy: num('Start Y as a 0-1 fraction of the display height.', { minimum: 0, maximum: 1 }),
      fx2: num('End X fraction (swipe/drag/fling).', { minimum: 0, maximum: 1 }),
      fy2: num('End Y fraction (swipe/drag/fling).', { minimum: 0, maximum: 1 }),
      x: num('X pixel (click/swipe start).'),
      y: num('Y pixel (click/swipe start).'),
      x2: num('End X pixel (swipe/drag/fling).'),
      y2: num('End Y pixel (swipe/drag/fling).'),
      speed: num('Velocity for swipe/drag/fling, px/s.'),
      key: str(
        'Key for keyEvent: Back/Home/Power, a name (Delete, Enter, Tab, Escape, MoveHome, MoveEnd, …), a letter, a ' +
          'KeyCode id, or a combo like Ctrl+A.',
      ),
      text: str('Text for inputText.'),
      clear: bool('inputText: clear the field (Ctrl+A, Delete) before typing.', false),
      hideKeyboard: bool('Dismiss the soft keyboard afterwards, if it is up.', false),
      ...DEVICE,
    },
    ['type'],
  ),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  changesDevice: true,
  async call(a, ctx) {
    const { config, logger } = rt();
    const result = await performInput({
      config,
      type: a.type as UiInputType,
      target: selectorFromArgs(a),
      targetIndex: targetIndexFromArgs(a),
      fx: a.fx as number | undefined,
      fy: a.fy as number | undefined,
      fx2: a.fx2 as number | undefined,
      fy2: a.fy2 as number | undefined,
      pxX: a.x as number | undefined,
      pxY: a.y as number | undefined,
      pxX2: a.x2 as number | undefined,
      pxY2: a.y2 as number | undefined,
      speed: a.speed as number | undefined,
      key: a.key as string | undefined,
      text: a.text as string | undefined,
      clear: a.clear as boolean,
      hideKeyboard: a.hideKeyboard as boolean,
      deviceSerial: deviceOf(a, ctx),
      logger,
    });
    return jsonResult(result as unknown as Args);
  },
};

const DEFAULT_CONTACT_SHEET_FRAMES = 8;
// Margin kept around a target element when cropping to it, as a fraction of the display (as `screenshot --target`).
const TARGET_CROP_PAD = 0.02;

const screenshot: Tool = {
  name: 'screenshot',
  title: 'Take a screenshot',
  description:
    'Capture the screen and return it as an image, downscaled so its longest side is at most maxDim ' +
    '(`oniro-app screenshot --max-dim`). grid: overlay a 10x10 grid (axes 0.0-1.0) for picking fx/fy tap coordinates. ' +
    'crop / target*: a full-resolution crop of one region or element, for checking detail cheaply. contactSheet: ' +
    'capture a burst and tile it into one image with per-frame change diffs. diff: compare the screen with a baseline ' +
    'JPEG (pHash/dHash distance, pixel-change ratio, mean change). output: also write the image to a file (with diff: ' +
    'the full-resolution capture, usable as a later baseline).',
  inputSchema: object({
    output: str('Also write the image to this file (relative to the project).'),
    grid: bool('Overlay a 10x10 coordinate grid.', false),
    maxDim: int('Longest-side cap of the returned image, px.', { minimum: 256, maximum: 4096, default: 1024 }),
    crop: str('Crop to this region, given as 0-1 fractions of the screen: "x1,y1,x2,y2".'),
    ...targetProperties('Crop to'),
    contactSheet: bool('Capture a burst and composite it into one tiled contact sheet.', false),
    burst: int('With contactSheet: the number of frames.', { minimum: 1, default: DEFAULT_CONTACT_SHEET_FRAMES }),
    interval: int('With contactSheet: delay between frames, ms.', { minimum: 0, default: 50 }),
    diff: str(
      'Compare the screen with this baseline JPEG (relative to the project): pHash and dHash distance, pixel-change ' +
        'ratio, mean change.',
    ),
    ...PROJECT,
    ...DEVICE,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    const { config, logger } = rt();
    const deviceSerial = deviceOf(a, ctx);
    const maxDim = a.maxDim as number;
    const output = pathArg(a, 'output', ctx);
    const selector = selectorFromArgs(a);

    if (a.diff !== undefined) {
      if (a.crop !== undefined || selector || a.grid || a.contactSheet) {
        throw new Error('diff cannot be combined with crop, target*, grid, or contactSheet.');
      }
      const baselinePath = pathArg(a, 'diff', ctx)!;
      let baseline: Buffer;
      try {
        baseline = fs.readFileSync(baselinePath);
      } catch (err) {
        throw new Error(`Cannot read the baseline ${baselinePath}: ${message(err)}`);
      }
      const shot = await takeScreenshot({ config, deviceSerial, logger });
      if (output) fs.writeFileSync(output, shot.pixels);
      const diff = await diffScreenshots(baseline, shot.pixels);
      const shown = await renderWithGrid(shot.pixels, { maxDim });
      return jsonResult({ baseline: baselinePath, current: output ?? null, ...diff }, false, [jpeg(shown.buf)]);
    }

    if (a.crop !== undefined || selector) {
      if (a.crop !== undefined && selector) throw new Error('Use either crop or target*, not both.');
      if (a.grid || a.contactSheet) throw new Error('crop / target cannot be combined with grid or contactSheet.');
      let rect: CropRect;
      let label: string;
      if (selector) {
        // Leave the keyboard alone: dismissing it would change what we are capturing.
        const located = await locateTarget({
          config,
          selector,
          index: targetIndexFromArgs(a),
          hideKeyboard: false,
          deviceSerial,
          logger,
        });
        if (!located.node.b) throw new Error(`${describeLayoutNode(located.node)} has no bounds to crop to.`);
        rect = padCropRect(located.node.b, TARGET_CROP_PAD);
        label = describeLayoutNode(located.node);
      } else {
        rect = parseCropRect(a.crop as string);
        label = rect.map((n) => n.toFixed(3)).join(',');
      }
      const shot = await takeScreenshot({ config, deviceSerial, logger });
      const cropped = await cropImage(shot.pixels, rect, { maxDim });
      if (output) fs.writeFileSync(output, cropped.buf);
      const { buf, ...dims } = cropped;
      return jsonResult({ output: output ?? null, region: label, ...dims }, false, [jpeg(buf)]);
    }

    if (a.contactSheet) {
      const intervalMs = a.interval as number;
      const frames = await captureBurst({ config, count: a.burst as number, intervalMs, deviceSerial, logger });
      const diffs = await frameDiffs(frames);
      const sheet = await buildContactSheet(frames, { maxDim, diffs });
      if (output) fs.writeFileSync(output, sheet.buf);
      const json = {
        sheet: output ?? null,
        frameCount: frames.length,
        cols: sheet.cols,
        rows: sheet.rows,
        intervalMs,
        note: 't_ms is nominal (idx*interval); diffVsPrev is 0..1 mean greyscale diff vs the previous frame.',
        frames: frames.map((_, i) => ({ idx: i, t_ms: i * intervalMs, diffVsPrev: diffs[i] ?? 0 })),
      };
      return jsonResult(json, false, [jpeg(sheet.buf)]);
    }

    const shot = await takeScreenshot({ config, deviceSerial, logger });
    const rendered = await renderWithGrid(shot.pixels, { maxDim, grid: !!a.grid });
    if (output) fs.writeFileSync(output, rendered.buf);
    const { buf, ...dims } = rendered;
    return jsonResult({ output: output ?? null, grid: !!a.grid, ...dims }, false, [jpeg(buf)]);
  },
};

const wait: Tool = {
  name: 'wait',
  title: 'Wait for a device condition',
  description:
    'Wait for a device condition (`oniro-app wait --json`): a hilog line (log), boot (boot), a bundle to start ' +
    '(bundle), or an on-screen element (target / targetId / targetType, or its absence with gone). Returns the ' +
    'matched log entry or element, or {booted}, {gone}, {bundle, running}. isError on timeout.',
  inputSchema: object({
    log: str('Resolve when a hilog line (tag: message) logged after the call starts matches this regex.'),
    since: str(
      'With log: also match lines logged up to N seconds before the call started, measured on the device clock; ' +
        '"all" matches everything still in the device log buffer.',
    ),
    boot: bool('Resolve when the device is reachable (optionally also pidOf).', false),
    bundle: str('With log: filter to this bundle. Alone: wait until this bundle is running.'),
    pidOf: str('With boot: also require this process to have a pid.'),
    domain: str('With log: hilog domain filter (e.g. 0xD003900).'),
    ...targetProperties('Resolve when', { index: false }),
    gone: bool('With target*: resolve when no uncovered element matches any more.', false),
    interval: int('With target*: poll interval, ms (each poll is a layout dump).', { minimum: 1, default: 500 }),
    timeout: int('Max wait, ms.', { minimum: 0, default: 30_000 }),
    ...DEVICE,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    const { config, logger } = rt();
    const deviceSerial = deviceOf(a, ctx);
    const timeoutMs = a.timeout as number;
    const selector = selectorFromArgs(a);
    if (a.since !== undefined && !a.log) throw new Error('since applies only to log.');
    if (a.log) {
      const entry = await waitForLog({
        config,
        pattern: new RegExp(a.log as string),
        timeoutMs,
        bundle: a.bundle as string | undefined,
        domain: a.domain as string | undefined,
        deviceSerial,
        lookbackMs: parseSince(a.since as string | undefined),
        logger,
      });
      return jsonResult(entry as unknown as Args);
    }
    if (a.boot) {
      await waitForBoot({ config, untilPidOf: a.pidOf as string | undefined, timeoutMs, deviceSerial, logger });
      return jsonResult({ booted: true });
    }
    if (selector) {
      const node = await waitForTarget({
        config,
        selector,
        gone: a.gone as boolean,
        timeoutMs,
        pollMs: a.interval as number,
        deviceSerial,
        logger,
      });
      return jsonResult(node ? (node as unknown as Args) : { gone: true });
    }
    if (a.bundle) {
      await waitForBundle({ config, bundle: a.bundle as string, timeoutMs, deviceSerial, logger });
      return jsonResult({ bundle: a.bundle, running: true });
    }
    throw new Error('Specify one of log, boot, bundle, or target (or targetId / targetType).');
  },
};

const logsCrash: Tool = {
  name: 'logs_crash',
  title: 'Explain the last crash',
  description:
    'Fetch the newest faultlog of an app from the device and say what happened (`oniro-app logs crash --json`): a ' +
    'native crash (cpp_crash), an uncaught ArkTS/JS error (js_crash), a freeze (app_freeze), or none. Returns crashed, ' +
    'kind, subtype, confidence, bundle, pid, time, reason, topFrame, projectFrame, file, line, column, jsError, stack, ' +
    'nativeFrames, jsFrames, binderChain, deadlocks, notes, path, rawPath; `{crashed: false, kind: null}` when there is ' +
    'no fault. Not an error when there was no crash: check `crashed`.',
  inputSchema: object({
    bundle: str("App to look for (default: the bundleName of the project, else any process)."),
    since: str('Only faults from the last N seconds (device clock), or since an ISO 8601 time.'),
    wait: int(
      'Keep looking this long when there is no fault yet, ms; hiview writes the faultlog a few seconds after the process dies.',
      { minimum: 0, default: 0 },
    ),
    path: str('Analyse this local faultlog (or faultloggerd .json crash record) instead of fetching one.'),
    output: str('Where to save the fetched faultlog.', { default: path.join(os.homedir(), '.oniro', 'faultlogs') }),
    ...PROJECT,
    ...DEVICE,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    const since = parseCrashSince(a.since as string | undefined);
    const local = pathArg(a, 'path', ctx);
    const bundle = (a.bundle as string | undefined) ?? (local ? undefined : projectBundle(projectOf(a, ctx)));
    let verdict: CrashVerdict | null;
    if (local) {
      verdict = analyzeFaultLog(fs.readFileSync(local, 'utf8'), { name: path.basename(local), path: local, rawPath: local });
    } else {
      const { config, logger } = rt();
      verdict = await latestCrash({
        config,
        bundle,
        since,
        waitMs: a.wait as number,
        deviceSerial: deviceOf(a, ctx),
        saveDir: pathArg(a, 'output', ctx),
        logger,
      });
    }
    const none = { crashed: false, kind: null, bundle: bundle ?? null, since: since instanceof Date ? since.toISOString() : since ?? null };
    return jsonResult((verdict ?? none) as unknown as Args);
  },
};

const screens: Tool = {
  name: 'screens',
  title: 'Inventory pages and routes',
  description:
    'Static inventory of the pages and routes of a project, from its sources, without a build or a device ' +
    '(`oniro-app screens --json`): @Entry and NavDestination pages, the router/NavPathStack call sites between them, ' +
    'the content nodes each page renders, and placeholder markers (TODO/FIXME, placeholder-like text, empty build()). ' +
    'Returns pages (name, module, file, line, component, entry, kind, registered, contentNodes, routesOut), routes ' +
    '(from, to, file, line, via, dynamic), placeholders (file, line, text, kind), warnings, modules, projectDir.',
  inputSchema: object({ ...PROJECT }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    try {
      return jsonResult(inventoryScreens({ projectDir: projectOf(a, ctx) }) as unknown as Args);
    } catch (err) {
      return jsonResult({ error: message(err) }, true);
    }
  },
};

const SDK_PROPS: Record<string, JsonSchema> = {
  api: int(
    "The SDK API level to read. Default: the project's compileSdkVersion, else the newest installed SDK.",
    { minimum: 1 },
  ),
  sdk: str('An SDK API directory (holding ets/) to read instead.'),
  project: str("The project whose compileSdkVersion picks the SDK (default: the server's --project)."),
  rebuild: bool('Rebuild the index even if the cached one is current.', false),
};

const API_KINDS = [
  'namespace',
  'class',
  'interface',
  'enum',
  'enumMember',
  'type',
  'function',
  'method',
  'constructor',
  'property',
  'variable',
  'component',
  'decorator',
  'macro',
  'typedef',
  'struct',
];

function sdkOpts(a: Args, ctx: ToolContext): { api?: string; sdk?: string; project: string; rebuild?: boolean } {
  return {
    api: a.api !== undefined ? String(a.api) : undefined,
    sdk: pathArg(a, 'sdk', ctx),
    project: projectOf(a, ctx),
    rebuild: a.rebuild as boolean,
  };
}

const apiSearch: Tool = {
  name: 'api_search',
  title: 'Search the SDK API',
  description:
    "Ranked search of the SDK's declarations at one API level (`oniro-app api search --json`): the ArkTS API, the " +
    'ArkUI components and decorators, and the Node-API C headers. Every word must match a symbol name (exact > prefix > ' +
    'camelCase part > substring) or its doc line; a dotted word matches qualified names (`router.pushUrl`). Returns ' +
    'sdk, query, total, hits (name, qualifiedName, kind, kit, import, module, since, deprecated, useInstead, syscap, ' +
    'systemApi, file, path, line, signature, doc, overloads, score). isError when nothing matches.',
  inputSchema: object(
    {
      query: str('The search words, e.g. "navigation push" or "router.pushUrl".'),
      kit: str('Only symbols this kit exports (`ArkUI` or `@kit.ArkUI`).'),
      kind: { type: 'array', items: { type: 'string', enum: API_KINDS }, description: 'Only these kinds.' },
      lang: { type: 'string', enum: ['arkts', 'c'], description: 'Only `arkts` declarations or `c` (Node-API headers).' },
      limit: int('At most n hits.', { minimum: 1, default: 20 }),
      deprecated: bool('Include @deprecated symbols (false = --no-deprecated).', true),
      systemapi: bool('Include @systemapi symbols, for system apps only (false = --no-systemapi).', true),
      ...SDK_PROPS,
    },
    ['query'],
  ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    const run = runApiSearch(a.query as string, {
      ...sdkOpts(a, ctx),
      kit: a.kit as string | undefined,
      kind: a.kind as string[] | undefined,
      lang: a.lang as string | undefined,
      limit: String(a.limit),
      deprecated: a.deprecated as boolean,
      systemapi: a.systemapi as boolean,
    });
    return jsonResult(run.json, run.total === 0);
  },
};

const apiShow: Tool = {
  name: 'api_show',
  title: 'Look up one SDK symbol',
  description:
    'Exact lookup (`oniro-app api show --json`): is `symbol` declared at this API level? Takes a qualified name ' +
    '(`NavPathStack.pushPathByName`, `router.pushUrl`, `Column`, `@Local`, `napi_create_threadsafe_function`); when none ' +
    'matches, names that end with it. Returns sdk, symbol, found, entries (the api_search hit fields, every overload), ' +
    'and on a miss alsoIn ([{api, since}], the other installed SDKs that declare it) and suggestions. isError when it is ' +
    'not declared.',
  inputSchema: object(
    {
      symbol: str('The symbol, e.g. `NavPathStack.pushPathByName`.'),
      kit: str('Only declarations this kit exports.'),
      otherSdks: bool('On a miss, look in the other installed SDKs (false = --no-other-sdks).', true),
      ...SDK_PROPS,
    },
    ['symbol'],
  ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    const run = runApiShow(a.symbol as string, {
      ...sdkOpts(a, ctx),
      kit: a.kit as string | undefined,
      otherSdks: a.otherSdks as boolean,
    });
    return jsonResult(run.json, !run.found);
  },
};

const doctor: Tool = {
  name: 'doctor',
  title: 'Check the toolchain',
  description:
    'Check that this machine can build, check, sign, install and test (`oniro-app doctor --json`): node, java, the SDK ' +
    'the project compiles with, the command-line tools, a `check arkts` self-test, hdc and a reachable device at the ' +
    "project's API, signing material, free disk space. Returns ok, checks (id, status ok/warn/fail/skip, detail, fix, " +
    'fixed), project, versions. isError when a check fails.',
  inputSchema: object({
    project: str("Project directory (default: the server's --project when it holds build-profile.json5)."),
    fix: bool("Install the project's missing OpenHarmony SDK.", false),
    device: bool('Check the device (false = --no-device, for a machine that only builds).', true),
    serial: str("The device to check, when several are connected (default: the server's --device)."),
    arktsCheck: bool('Run the `check arkts` self-test (false = --no-arkts-check).', true),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a, ctx) {
    const { config, logger, progress } = getRuntime();
    let dir: string | undefined;
    if (typeof a.project === 'string') dir = projectOf(a, ctx);
    else if (fs.existsSync(path.join(ctx.projectDir, 'build-profile.json5'))) dir = ctx.projectDir;
    const report = await runDoctor({
      config,
      projectDir: dir,
      fix: a.fix as boolean,
      device: a.device as boolean,
      deviceSerial: (a.serial as string | undefined) ?? ctx.deviceSerial,
      arktsSelfTest: a.arktsCheck as boolean,
      logger,
      progress,
    });
    return jsonResult(report as unknown as Args, doctorExitCode(report) !== 0);
  },
};

const devices: Tool = {
  name: 'devices',
  title: 'List devices',
  description:
    'List the connected hdc devices (`oniro-app devices --json`), as `{devices: [{serial, connection, status}]}`. ' +
    'long: also ask each connected device for its OS family, version, API level, CPU ABI, device type and model (`info`).',
  inputSchema: object({
    long: bool(
      'Also ask each connected device for its OS family (HarmonyOS / OpenHarmony), version, API level, CPU ABI, device type and model.',
      false,
    ),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  changesDevice: false,
  async call(a) {
    const long = a.long as boolean;
    const { devices: list, infos } = await queryDevices(long);
    return jsonResult({ devices: devicesJson(list, infos, long) });
  },
};

/** Every tool, in the order `tools/list` shows them. */
export const ALL_TOOLS: readonly Tool[] = [
  build,
  checkArktsTool,
  test,
  apply,
  launch,
  dumpLayoutTool,
  input,
  screenshot,
  wait,
  logsCrash,
  screens,
  apiSearch,
  apiShow,
  doctor,
  devices,
];

export const TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);

/**
 * The tools to expose: `names` (all when undefined), less those that change the
 * device when `readOnly`. Throws on an unknown name.
 */
export function selectTools(names: string[] | undefined, readOnly: boolean): Tool[] {
  if (names) {
    const unknown = names.filter((n) => !TOOL_NAMES.includes(n));
    if (unknown.length) throw new Error(`Unknown tool${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. Tools: ${TOOL_NAMES.join(', ')}.`);
  }
  return ALL_TOOLS.filter((t) => (!names || names.includes(t.name)) && !(readOnly && t.changesDevice));
}
