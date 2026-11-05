import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * A real capture (API 26 device, `ace app graphic ability window`): a cold launch
 * of a test app (com.example.perfprobe, pid 22334) whose list rows burn 12 ms
 * each on the UI thread, a scroll, a button that burns 600 ms, another scroll.
 * Trimmed to the markers the summary reads (the app's main-thread top-level
 * slices and frames, the launch chain, RenderService's first-frame and scene
 * reports), B/E pairs kept balanced.
 */
export const PERF_FIXTURE = path.join(here, '..', 'fixtures', 'perf', 'launch-scroll.ftrace.txt');
export const PERF_APP = 'com.example.perfprobe';

export interface FakePerfDevice {
  root: string;
  hdc: string;
  /** Every shell command, in order (`hdc shell a b c` joined with spaces). */
  commands(): string[];
  cleanup(): void;
}

/**
 * A stand-in hdc: hitrace begins (failing with 1103 once when `busy` exists,
 * or always when `bogus` is in the categories), finishes, `file recv` hands
 * back the real trace fixture, `pidof` answers 22334, hidumper reports 59 Hz.
 */
export function fakePerfDevice(): FakePerfDevice {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-perf-test-'));
  fs.writeFileSync(path.join(root, 'targets.txt'), 'FAKE\tUSB\tConnected\tlocalhost\n');
  fs.writeFileSync(path.join(root, 'commands.log'), '');
  const hdc = path.join(root, 'hdc');
  fs.writeFileSync(
    hdc,
    `#!/bin/sh
R='${root}'
[ "$1" = "-t" ] && shift 2
case "$1" in
  list) cat "$R/targets.txt"; exit 0 ;;
  file) cp '${PERF_FIXTURE}' "$4"; echo "FileTransfer finish, Size:1, File count = 1"; exit 0 ;;
  shell)
    shift
    cmd="$*"
    echo "\${cmd%%; echo*}" >> "$R/commands.log"
    rc=0
    case "$cmd" in
      'hitrace --trace_begin'*bogus*) echo "error: bogus is not support category on this device."; rc=255 ;;
      'hitrace --trace_begin'*)
        if [ -f "$R/busy" ]; then rm "$R/busy"; echo "error: OpenRecording failed, errorCode(1103)"; rc=255
        else echo "OpenRecording done."; fi ;;
      'hitrace --trace_finish -o'*) echo "trace read done, output: x" ;;
      'hitrace --trace_finish_nodump'*) echo "end capture trace." ;;
      'aa start'*) echo "start ability successfully." ;;
      'aa force-stop'*) echo "force stop process successfully." ;;
      pidof*) echo 22334 ;;
      'hidumper -s RenderService -a screen') echo "activeMode: 1080x2400, refreshRate=59" ;;
      *) : ;;
    esac
    echo "__ONIRO_RC=\${rc}__"
    exit 0 ;;
esac
exit 0
`,
  );
  fs.chmodSync(hdc, 0o755);
  return {
    root,
    hdc,
    commands: () => fs.readFileSync(path.join(root, 'commands.log'), 'utf8').split('\n').filter(Boolean),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
