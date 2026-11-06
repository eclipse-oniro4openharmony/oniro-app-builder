import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findCoveredNodes, pruneLayout, type LayoutNode, type RawLayoutNode } from '../../src/hdc/dump.js';

/**
 * Raw `uitest dumpLayout` trees of the FlowProbe test app (a name field and a
 * Continue button; a page with a greeting, a "Picked:" label and a fruit list;
 * the soft keyboard), at the bounds a 1080x2400 device reported, so the touch
 * points in fixtures/flow/record.csv (a real recording) land on them.
 */
export const DISPLAY = { width: 1080, height: 2400 };
export const APP = 'com.example.flowprobe';
export const IME = 'com.example.kikakeyboard';

const node = (attributes: Record<string, string>, children: RawLayoutNode[] = []): RawLayoutNode => ({ attributes, children });

const keyboard = (): RawLayoutNode =>
  node({ type: 'root', bundleName: IME, hostWindowId: '3', bounds: '[0,1368][1080,2400]', backgroundColor: '#FFEEEEEE' }, [
    node({ type: 'Flex', hostWindowId: '3', bounds: '[600,1900][700,2000]', clickable: 'true' }, [
      node({ type: 'Text', text: 'b', hostWindowId: '3', bounds: '[631,1917][668,1987]' }),
    ]),
    node({ type: 'Flex', hostWindowId: '3', bounds: '[860,1560][960,1670]', clickable: 'true' }, [
      node({ type: 'Text', text: 'o', hostWindowId: '3', bounds: '[893,1581][929,1651]' }),
    ]),
  ]);

/** The start page: the name field holds `name`; `kb` shows the soft keyboard (and focuses the field). */
export function rawPage1(name: string, kb: boolean, button = 'Continue'): RawLayoutNode {
  return node({}, [
    node({ type: 'root', bundleName: APP, hostWindowId: '100', bounds: '[0,0][1080,2400]' }, [
      node({ type: 'Text', id: 'title', text: 'Flow probe', hostWindowId: '100', bounds: '[300,370][780,440]' }),
      node({
        type: 'TextInput', id: 'nameInput', hint: 'Your name', text: name, hostWindowId: '100', bounds: '[54,503][1026,623]',
        clickable: 'true', focused: kb ? 'true' : 'false',
      }),
      node({ type: 'Button', id: 'continueBtn', text: button, hostWindowId: '100', bounds: '[216,671][864,791]', clickable: 'true' }),
    ]),
    ...(kb ? [keyboard()] : []),
  ]);
}

const FRUITS = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry'];

/** The second page, greeting `name`, with `picked` as the picked fruit. */
export function rawPage2(name: string, picked: string): RawLayoutNode {
  return node({}, [
    node({ type: 'root', bundleName: APP, hostWindowId: '100', bounds: '[0,0][1080,2400]' }, [
      node({ type: 'Text', id: 'greeting', text: `Hello ${name}`, hostWindowId: '100', bounds: '[300,360][780,440]' }),
      node({ type: 'Text', id: 'picked', text: `Picked: ${picked}`, hostWindowId: '100', bounds: '[300,470][780,540]' }),
      node(
        { type: 'List', id: 'fruitList', hostWindowId: '100', bounds: '[54,576][1026,2040]', scrollable: 'true' },
        FRUITS.map((f, i) =>
          node({ type: 'ListItem', hostWindowId: '100', bounds: `[54,${576 + i * 166}][1026,${718 + i * 166}]`, clickable: 'true' }, [
            node({ type: 'Text', text: f, hostWindowId: '100', bounds: `[54,${576 + i * 166}][1026,${718 + i * 166}]` }),
          ]),
        ),
      ),
      node({ type: 'Button', id: 'backBtn', text: 'Back', hostWindowId: '100', bounds: '[440,2080][640,2190]', clickable: 'true' }),
    ]),
  ]);
}

/** The home screen: no FlowProbe window. */
export function rawHome(): RawLayoutNode {
  return node({}, [
    node({ type: 'root', bundleName: 'com.ohos.sceneboard', hostWindowId: '7', bounds: '[0,0][1080,2400]' }, [
      node({ type: 'Text', text: 'Clock', hostWindowId: '7', bounds: '[100,500][300,560]', clickable: 'true' }),
    ]),
  ]);
}

/** A raw tree pruned the way `dumpLayout` prunes it. */
export function pruned(raw: RawLayoutNode): LayoutNode {
  const p = pruneLayout(raw, DISPLAY, findCoveredNodes(raw));
  return Array.isArray(p) ? { children: p } : (p ?? { children: [] });
}

export interface FakeDevice {
  root: string;
  hdc: string;
  /** Show this raw layout to the next dumps. */
  show(raw: RawLayoutNode): void;
  /** Each uiInput command (or `snapshot_display`) shows the next of these, in order. */
  queue(...raws: RawLayoutNode[]): void;
  /** The `uitest uiInput …` commands sent so far. */
  inputs(): string[];
  /** How many `uitest dumpLayout` the device has served. */
  dumps(): number;
  /** Make `hdc list targets` report no device. */
  disconnect(): void;
  cleanup(): void;
}

/**
 * A stand-in `hdc` for one device: `uitest dumpLayout` serves the layout last
 * passed to `show` (the queue advances it on each `uitest uiInput`), hidumper
 * reports a 1080x2400 display, screenshots are a few bytes, and the recorder
 * commands (`uitest uiRecord record`, `kill`, `date`, `stat`, `cat`, `hilog -D`)
 * replay files under `rec/` (record.csv, stat.txt, touches.hilog, layout_*.json)
 * and `dumps/<n>.json` for the n-th dump when present.
 */
export function fakeDevice(): FakeDevice {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-flow-'));
  for (const d of ['queue', 'rec', 'dumps']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'targets.txt'), 'FAKE\tUSB\tConnected\tlocalhost\n');
  fs.writeFileSync(path.join(root, 'inputs.log'), '');
  fs.writeFileSync(path.join(root, 'dumpcount'), '0');
  const hdc = path.join(root, 'hdc');
  fs.writeFileSync(
    hdc,
    `#!/bin/sh
R='${root}'
[ "$1" = "-t" ] && shift 2
case "$1" in
  list) cat "$R/targets.txt"; exit 0 ;;
  file)
    case "$3" in
      *layout_*) cp "$R/rec/$(basename "$3")" "$4" ;;
      *fake_layout*)
        n=$(cat "$R/dumpcount")
        if [ -f "$R/dumps/$n.json" ]; then cp "$R/dumps/$n.json" "$4"; else cp "$R/screen.json" "$4"; fi ;;
      *) printf 'JPEG' > "$4" ;;
    esac
    echo "FileTransfer finish"; exit 0 ;;
  shell)
    cmd="$2"
    case "$cmd" in
      'uitest dumpLayout'*)
        echo $(( $(cat "$R/dumpcount") + 1 )) > "$R/dumpcount"
        echo "DumpLayout saved to:/data/local/tmp/fake_layout.json" ;;
      'hidumper -s 10 -a screen') echo "render resolution=1080x2400" ;;
      'hidumper -s 3301'*) echo "Current State: AWAKE" ;;
      hidumper*) : ;;
      'uitest uiInput'*)
        echo "\${cmd%%;*}" >> "$R/inputs.log"
        next=$(ls "$R/queue" | sort -n | head -1)
        if [ -n "$next" ]; then mv "$R/queue/$next" "$R/screen.json"; fi
        echo "No Error"; echo "__ONIRO_RC=0__" ;;
      'uitest uiRecord record'*) echo "ONIRO_PID=4242" ;;
      'cat /data/local/tmp/oniro_record_console.txt')
        printf 'Current ForAbility :com.example.flowprobe, EntryAbility\\nStarted Recording Successfully...\\n' ;;
      'cat /data/local/tmp/record.csv') cat "$R/rec/record.csv" ;;
      'kill -0'*) [ -f "$R/stopped" ] || echo alive; echo 7 ;;
      'kill -INT'*) touch "$R/stopped" ;;
      date*) echo "2026-11-05 14:41:57.533855039 +0100" ;;
      'stat '*) cat "$R/rec/stat.txt" ;;
      hilog*) cat "$R/rec/touches.hilog" ;;
      'param get const.ohos.apiversion') echo 26 ;;
      *) : ;;
    esac
    exit 0 ;;
esac
exit 0
`,
  );
  fs.chmodSync(hdc, 0o755);
  let queued = 0;
  const write = (file: string, raw: RawLayoutNode): void => fs.writeFileSync(file, JSON.stringify(raw));
  return {
    root,
    hdc,
    show: (raw) => write(path.join(root, 'screen.json'), raw),
    queue: (...raws) => {
      for (const raw of raws) write(path.join(root, 'queue', String(++queued)), raw);
    },
    inputs: () => fs.readFileSync(path.join(root, 'inputs.log'), 'utf8').split('\n').filter(Boolean),
    dumps: () => Number(fs.readFileSync(path.join(root, 'dumpcount'), 'utf8').trim()),
    disconnect: () => fs.writeFileSync(path.join(root, 'targets.txt'), '[Empty]\n'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
