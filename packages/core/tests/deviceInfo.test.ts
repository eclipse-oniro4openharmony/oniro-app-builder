import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { getDeviceInfo } from '../src/device/info.js';
import { dumpScreen, dumpWindow, dumpRenderService } from '../src/device/hidumper.js';

const isWin = process.platform === 'win32';

// Fake hdc: canned param values + hidumper outputs.
describe.skipIf(isWin)('device info + hidumper (fake hdc)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-dev-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
case "$1" in
  shell)
    case "$2" in
      "param get const.product.model") printf 'PixelTest\\n'; exit 0 ;;
      "param get const.product.manufacturer") printf 'Acme\\n'; exit 0 ;;
      "param get"*) printf 'val\\n'; exit 0 ;;
      hidumper*screen) printf 'render resolution=1080x2340\\n'; exit 0 ;;
      *WindowManager*) printf 'window dump text\\n'; exit 0 ;;
      *RenderService*) printf 'render dump text\\n'; exit 0 ;;
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

  it('getDeviceInfo collates params and display', async () => {
    const info = await getDeviceInfo({ config: config() });
    expect(info.model).toBe('PixelTest');
    expect(info.manufacturer).toBe('Acme');
    expect(info.brand).toBe('val'); // generic param fallthrough
    expect(info.display).toEqual({ width: 1080, height: 2340 });
  });

  it('dumpScreen parses resolution; window/render dumps return raw text', async () => {
    expect(await dumpScreen({ config: config() })).toEqual({
      width: 1080,
      height: 2340,
      raw: 'render resolution=1080x2340\n',
    });
    expect(await dumpWindow({ config: config() })).toContain('window dump text');
    expect(await dumpRenderService({ config: config() })).toContain('render dump text');
  });
});
