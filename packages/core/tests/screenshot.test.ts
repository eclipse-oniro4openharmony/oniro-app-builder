import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { SNAPSHOT_ATTEMPTS, snapshotCommand, snapshotFailureDetail, takeScreenshot } from '../src/hdc/screen.js';

const isWin = process.platform === 'win32';

// What snapshot_display prints when RenderService does not deliver a frame in time
// (seen on the OpenHarmony 7.0 emulator while an app starts).
const RS_TIMEOUT_OUTPUT = [
  'fileType: ',
  'process: display 0, file type: jpeg, width: 360, height: 720',
  'fileType: jpeg',
  '',
  'error: snapshot display 0, write to /data/local/tmp/s.jpeg as jpeg failed!',
].join('\n');

describe('snapshotFailureDetail', () => {
  it("keeps snapshot_display's error line", () => {
    expect(snapshotFailureDetail(RS_TIMEOUT_OUTPUT)).toBe(
      'error: snapshot display 0, write to /data/local/tmp/s.jpeg as jpeg failed!',
    );
  });

  it('falls back to the last lines, then to a fixed message', () => {
    expect(snapshotFailureDetail('a\nb\nc\nd\n')).toBe('b\nc\nd');
    expect(snapshotFailureDetail('')).toBe('snapshot_display wrote no file.');
  });
});

describe('snapshotCommand', () => {
  it('removes an old copy and reports success only for a written file', () => {
    expect(snapshotCommand('/data/local/tmp/x.jpeg')).toBe(
      'rm -f /data/local/tmp/x.jpeg; snapshot_display -f /data/local/tmp/x.jpeg; ' +
        '[ -s /data/local/tmp/x.jpeg ] && echo __ONIRO_SNAPSHOT_OK__',
    );
  });
});

// Fake hdc: the first $FAILS captures print the RenderService-timeout output and
// write nothing, later ones succeed. Every capture command is logged.
describe.skipIf(isWin)('takeScreenshot retries (fake hdc)', () => {
  let root: string;

  const write = (name: string, content: string) => fs.writeFileSync(path.join(root, name), content);
  const captures = () => fs.readFileSync(path.join(root, 'captures.log'), 'utf8').split('\n').filter(Boolean);
  const recvs = () => fs.readFileSync(path.join(root, 'recv.log'), 'utf8').split('\n').filter(Boolean);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-shot-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    write('captures.log', '');
    write('recv.log', '');
    write('fails', '0');
    write('rs_timeout.txt', `${RS_TIMEOUT_OUTPUT}\n`);
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
R='${root}'
case "$1" in
  shell)
    case "$2" in
      *snapshot_display*)
        echo "$2" >> "$R/captures.log"
        n=$(wc -l < "$R/captures.log")
        if [ "$n" -le "$(cat "$R/fails")" ]; then cat "$R/rs_timeout.txt"; else echo "__ONIRO_SNAPSHOT_OK__"; fi ;;
      hidumper*) echo "render resolution=360x720" ;;
    esac
    exit 0 ;;
  file)
    echo "$3" >> "$R/recv.log"
    printf 'JPEG' > "$4"
    exit 0 ;;
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

  it('retries a capture that wrote no file and returns the later frame', async () => {
    write('fails', String(SNAPSHOT_ATTEMPTS - 1));
    const shot = await takeScreenshot({ config: config() });
    expect(shot.pixels.toString()).toBe('JPEG');
    expect(shot).toMatchObject({ width: 360, height: 720 });
    expect(captures()).toHaveLength(SNAPSHOT_ATTEMPTS);
    expect(recvs()).toHaveLength(1);
  });

  it("gives up after the last attempt with snapshot_display's message and pulls nothing", async () => {
    write('fails', '99');
    await expect(takeScreenshot({ config: config() })).rejects.toThrow(
      /wrote no file in 3 attempts\.\nerror: snapshot display 0, write to .* failed!/,
    );
    expect(captures()).toHaveLength(SNAPSHOT_ATTEMPTS);
    expect(recvs()).toHaveLength(0);
  });

  it('captures into a new remote file on every call', async () => {
    await takeScreenshot({ config: config() });
    await takeScreenshot({ config: config() });
    const [a, b] = recvs();
    expect(a).toMatch(/^\/data\/local\/tmp\/oniro_screenshot_[0-9a-f]{12}\.jpeg$/);
    expect(b).not.toBe(a);
  });
});
