import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { getDisplaySize, parseDisplaySize } from '../src/hdc/display.js';
import { sendInput } from '../src/hdc/input.js';

const isWin = process.platform === 'win32';

// Fake hdc: hidumper prints a resolution line; everything else exits 0.
describe.skipIf(isWin)('display + input wiring (fake hdc)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cap-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
case "$1" in
  shell)
    case "$2" in
      hidumper*) printf 'preamble\\nrender resolution=1080x2340\\ntrailing\\n'; [ -f "$0.rotated" ] && printf 'ScreenRotation:               270\\n'; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
`,
    );
    fs.chmodSync(hdc, 0o755);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const config = () => staticConfig({ cmdToolsPath: root });

  it('getDisplaySize parses render resolution', async () => {
    expect(await getDisplaySize(config())).toEqual({ width: 1080, height: 2340 });
  });

  it('getDisplaySize swaps width and height on a rotated screen', async () => {
    fs.writeFileSync(path.join(root, 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.rotated'), '');
    expect(await getDisplaySize(config())).toEqual({ width: 2340, height: 1080 });
  });

  it('sendInput issues the uitest command and resolves', async () => {
    await expect(sendInput({ config: config(), type: 'click', pxX: 100, pxY: 200 })).resolves.toBeUndefined();
  });
});

// RenderService and DisplayManagerService output as a 1080x2400 phone prints it
// (OpenHarmony 7.0), trimmed to the lines the parser looks at.
const RS_SCREEN =
  'screen[0]: id=0, powerStatus=POWER_STATUS_ON, backlight=26, screenType=EXTERNAL_TYPE, ' +
  'render resolution=1080x2400, physical resolution=1080x2400, isVirtual=false\n';
const dms = (degrees: string) => `ScreenRotation:               ${degrees}\n`;

describe('parseDisplaySize', () => {
  it('keeps the physical size in portrait', () => {
    expect(parseDisplaySize(RS_SCREEN + dms('0'))).toEqual({ width: 1080, height: 2400 });
    expect(parseDisplaySize(RS_SCREEN + dms('180'))).toEqual({ width: 1080, height: 2400 });
  });

  it('swaps width and height in landscape', () => {
    expect(parseDisplaySize(RS_SCREEN + dms('90'))).toEqual({ width: 2400, height: 1080 });
    expect(parseDisplaySize(RS_SCREEN + dms('270'))).toEqual({ width: 2400, height: 1080 });
    expect(parseDisplaySize(RS_SCREEN + dms('270.000000'))).toEqual({ width: 2400, height: 1080 });
  });

  it('falls back to the physical size without a ScreenRotation line', () => {
    expect(parseDisplaySize(RS_SCREEN)).toEqual({ width: 1080, height: 2400 });
  });

  it('ignores indented Rotation lines from other dump sections', () => {
    expect(parseDisplaySize(`${RS_SCREEN}Rotation:                     3\n  ScreenRotation: 90\n`)).toEqual({
      width: 1080,
      height: 2400,
    });
  });

  it('returns null without a render resolution', () => {
    expect(parseDisplaySize(dms('90'))).toBeNull();
  });
});
