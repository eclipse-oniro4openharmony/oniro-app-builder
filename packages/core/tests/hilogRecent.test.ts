import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import type { Logger } from '../src/ports/logger.js';
import { hilogTimeMs, waitForLog, watchLog } from '../src/hdc/hilog.js';

const isWin = process.platform === 'win32';

describe('hilogTimeMs', () => {
  const ref = Date.UTC(2026, 4, 19, 22, 35, 38);

  it('reads the time in the reference year', () => {
    expect(hilogTimeMs('05-19 22:35:37.818', ref)).toBe(Date.UTC(2026, 4, 19, 22, 35, 37, 818));
  });

  it('puts a December line read in January in the previous year', () => {
    const jan1 = Date.UTC(2027, 0, 1, 0, 0, 5);
    expect(hilogTimeMs('12-31 23:59:59.000', jan1)).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
  });

  it('returns null for another format', () => {
    expect(hilogTimeMs('2026-05-19 22:35:37', ref)).toBeNull();
  });
});

// Fake `hdc` whose clock reads 22:35:38: the buffer holds one line from the
// second before (render fail) and two from that second (hello world).
describe.skipIf(isWin)('waitForLog / watchLog skip lines logged before the call (fake hdc)', () => {
  let root: string;

  const writeHdc = (dateOutput: string): void => {
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
case "$1" in
  shell)
    case "$2" in
      date*) printf '${dateOutput}\\n'; exit 0 ;;
      hilog*)
        printf '05-19 22:35:37.818  3687  3712 E C01406/OHOS::RS: render fail\\n'
        printf '05-19 22:35:38.000  3687  3712 I MyTag: hello world\\n'
        printf '05-19 22:35:38.001  3687  3712 I MyTag: hello world\\n'
        exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
`,
    );
    fs.chmodSync(hdc, 0o755);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-recent-'));
    writeHdc('2026-05-19T22:35:38');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const config = () => staticConfig({ cmdToolsPath: root });

  it('waitForLog ignores a matching line from before the call', async () => {
    await expect(waitForLog({ config: config(), pattern: /render fail/, timeoutMs: 300 })).rejects.toThrow(
      /No log line matched/,
    );
  });

  it('waitForLog matches it within lookbackMs, or with Infinity', async () => {
    const recent = await waitForLog({ config: config(), pattern: /render fail/, timeoutMs: 5000, lookbackMs: 1000 });
    expect(recent.tag).toBe('C01406/OHOS::RS');
    const all = await waitForLog({ config: config(), pattern: /render fail/, timeoutMs: 5000, lookbackMs: Infinity });
    expect(all.message).toBe('render fail');
  });

  it('watchLog collects only the lines from the call onwards', async () => {
    const entries = await watchLog({ config: config(), pattern: /./, durationMs: 500, dedup: false });
    expect(entries.map((e) => e.message)).toEqual(['hello world', 'hello world']);
  });

  it('passes every line and warns when the device clock cannot be read', async () => {
    writeHdc('not a date');
    const warnings: string[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} };
    const entry = await waitForLog({ config: config(), pattern: /render fail/, timeoutMs: 5000, logger });
    expect(entry.message).toBe('render fail');
    expect(warnings.join('\n')).toMatch(/device clock/);
  });
});
