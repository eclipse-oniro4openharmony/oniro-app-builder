import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { jpegSize, SNAPSHOT_ATTEMPTS, snapshotCommand, snapshotFailureDetail, takeScreenshot } from '../src/hdc/screen.js';

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
    write('sizes.log', '');
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
      hidumper*) echo asked >> "$R/sizes.log"; echo "render resolution=360x720" ;;
    esac
    exit 0 ;;
  file)
    echo "$3" >> "$R/recv.log"
    if [ -f "$R/frame.jpeg" ]; then cp "$R/frame.jpeg" "$4"; else printf 'JPEG' > "$4"; fi
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

  it('takes the size from the picture, and asks the device only when the picture does not say', async () => {
    const asked = () => fs.readFileSync(path.join(root, 'sizes.log'), 'utf8').split('\n').filter(Boolean).length;
    // A frame header (SOF0) for 1080x2400 after the start of image.
    fs.writeFileSync(path.join(root, 'frame.jpeg'), Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0x09, 0x60, 0x04, 0x38, 1, 1, 0x11, 0]));
    expect(await takeScreenshot({ config: config() })).toMatchObject({ width: 1080, height: 2400 });
    expect(asked()).toBe(0);
    fs.rmSync(path.join(root, 'frame.jpeg'));
    expect(await takeScreenshot({ config: config() })).toMatchObject({ width: 360, height: 720 });
    expect(asked()).toBe(1);
  });

  it('captures into a new remote file on every call', async () => {
    await takeScreenshot({ config: config() });
    await takeScreenshot({ config: config() });
    const [a, b] = recvs();
    expect(a).toMatch(/^\/data\/local\/tmp\/oniro_screenshot_[0-9a-f]{12}\.jpeg$/);
    expect(b).not.toBe(a);
  });
});

describe('jpegSize', () => {
  const segment = (marker: number, body: number[]): number[] => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
  // SOI, an APP0 segment, a quantization table, then the frame header: 8 bits, height, width, 3 components.
  const frame = (marker: number, width: number, height: number): number[] =>
    segment(marker, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = (marker: number, width: number, height: number): Uint8Array =>
    Uint8Array.from([0xff, 0xd8, ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]), ...segment(0xdb, new Array(65).fill(1)), ...frame(marker, width, height), 0xff, 0xda]);

  it('reads the size from the frame header of a baseline or a progressive JPEG', () => {
    expect(jpegSize(jpeg(0xc0, 1080, 2400))).toEqual({ width: 1080, height: 2400 });
    expect(jpegSize(jpeg(0xc2, 2400, 1080))).toEqual({ width: 2400, height: 1080 });
  });

  it('does not take a Huffman table for a frame header, and gives up at the scan', () => {
    const bytes = Uint8Array.from([0xff, 0xd8, ...segment(0xc4, [0, 1, 2, 3, 4, 5, 6, 7]), ...frame(0xc0, 360, 800)]);
    expect(jpegSize(bytes)).toEqual({ width: 360, height: 800 });
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, ...frame(0xc0, 360, 800)]))).toBeNull();
  });

  it('is null for what is not a JPEG', () => {
    expect(jpegSize(Buffer.from('JPEG'))).toBeNull();
    expect(jpegSize(new Uint8Array())).toBeNull();
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))).toBeNull();
  });
});
