import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { reboot, waitForBundle } from '../src/hdc/lifecycle.js';
import { waitForLog, watchLog, dumpLog } from '../src/hdc/hilog.js';

const isWin = process.platform === 'win32';

// Fake `hdc`: canned pidof / hilog / param-set responses; echoes argv otherwise.
describe.skipIf(isWin)('lifecycle + hilog (fake hdc)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-life-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
case "$1" in
  shell)
    case "$2" in
      *notrunning*) exit 1 ;;
      pidof*) printf '12345\\n'; exit 0 ;;
      echo*) printf 'oniro_ping\\n'; exit 0 ;;
      hilog*)
        printf '05-19 22:35:37.818  3687  3712 E C01406/OHOS::RS: render fail\\n'
        printf '05-19 22:35:38.000  3687  3712 I MyTag: hello world\\n'
        printf '05-19 22:35:38.001  3687  3712 I MyTag: hello world\\n'
        exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
for a in "$@"; do printf '%s\\n' "$a"; done
exit 0
`,
    );
    fs.chmodSync(hdc, 0o755);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const config = () => staticConfig({ cmdToolsPath: root });

  it('waitForBundle resolves once pidof returns a numeric pid', async () => {
    await expect(waitForBundle({ config: config(), bundle: 'com.example.app', timeoutMs: 5000 })).resolves.toBeUndefined();
  });

  it('reboot (system, no waitForBundle) issues the command and resolves', async () => {
    await expect(reboot({ config: config() })).resolves.toBeUndefined();
  });

  it('waitForLog resolves with the first matching entry', async () => {
    const entry = await waitForLog({ config: config(), pattern: /hello world/, timeoutMs: 5000 });
    expect(entry.tag).toBe('MyTag');
    expect(entry.message).toBe('hello world');
  });

  it('waitForLog times out when nothing matches', async () => {
    await expect(
      waitForLog({ config: config(), pattern: /this_never_appears_zzz/, timeoutMs: 300 }),
    ).rejects.toThrow(/No log line matched/);
  });

  it('dumpLog parses the dumped lines', async () => {
    const entries = await dumpLog({ config: config() });
    expect(entries).toHaveLength(3);
    expect(entries[2]!.message).toBe('hello world');
  });

  it('dumpLog returns [] when the bundle is not running', async () => {
    expect(await dumpLog({ config: config(), bundle: 'com.notrunning' })).toEqual([]);
  });

  it('watchLog collects matching entries and dedups consecutive duplicates by default', async () => {
    const deduped = await watchLog({ config: config(), pattern: /hello world/, durationMs: 120 });
    expect(deduped).toHaveLength(1);
    const all = await watchLog({ config: config(), pattern: /hello world/, durationMs: 120, dedup: false });
    expect(all).toHaveLength(2);
  });
});
