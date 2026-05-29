import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { getDisplaySize } from '../src/hdc/display.js';
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
      hidumper*) printf 'preamble\\nrender resolution=1080x2340\\ntrailing\\n'; exit 0 ;;
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

  it('sendInput issues the uitest command and resolves', async () => {
    await expect(sendInput({ config: config(), type: 'click', pxX: 100, pxY: 200 })).resolves.toBeUndefined();
  });
});
