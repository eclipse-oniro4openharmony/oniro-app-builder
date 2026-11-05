import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeFaultLog,
  classifyFaultLog,
  isCrashJson,
  latestCrash,
  listFaultLogs,
  parseCrashRecordHeads,
  parseFaultLogList,
  parseFaultLogName,
  parseJsFrame,
  parseNativeFrame,
  parseUtcOffset,
  stripHidumperBanner,
} from '../src/faultlog/index.js';
import { staticConfig } from '../src/ports/config.js';

// Recorded on an OpenHarmony 7.0.0.39 phone (API 20 build of a probe app),
// with the fingerprint, device name and unique ids replaced.
const FIXTURES = path.join(__dirname, 'fixtures', 'faultlog');
const JS = 'jscrash-com.example.crashprobe-20010066-20261105123257298.log';
const FREEZE = 'appfreeze-com.example.crashprobe-20010066-20261105124232053.log';
const RECORD = 'cppcrash-16917-1793878741472.json';
const SERVICE_CPP = 'cppcrash-blue_host-3021-20261103125730374.log';
const SYSFREEZE = 'sysfreeze-render_service-1003-20261103121539892.log';
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const BANNER = '\n-------------------------------[ability]-------------------------------\n\n\n----------------------------------HiviewService----------------------------------\n';

describe('analyzeFaultLog on device faultlogs', () => {
  it('reads a JS crash: error, stack and the first project frame', () => {
    const v = analyzeFaultLog(fixture(JS), { name: JS, path: `/data/log/faultlog/faultlogger/${JS}` });
    expect(v).toMatchObject({
      crashed: true,
      kind: 'js_crash',
      confidence: 'high',
      completeness: 'full',
      bundle: 'com.example.crashprobe',
      process: 'com.example.crashprobe',
      pid: 9331,
      uid: 20010066,
      time: '2026-11-05 12:32:57.298',
      reason: 'RangeError',
      topFrame: 'at parseConfig entry (entry/src/main/ets/pages/Index.ets:8:13)',
      projectFrame: 'at parseConfig entry (entry/src/main/ets/pages/Index.ets:8:13)',
      file: 'entry/src/main/ets/pages/Index.ets',
      line: 8,
      column: 13,
      jsError: {
        name: 'RangeError',
        message: 'crashprobe: config too short (3)',
        stack: [
          'at parseConfig entry (entry/src/main/ets/pages/Index.ets:8:13)',
          'at aboutToAppear entry (entry/src/main/ets/pages/Index.ets:14:34)',
        ],
      },
      nativeFrames: [],
      name: JS,
      path: `/data/log/faultlog/faultlogger/${JS}`,
      rawPath: null,
    });
    expect(v.jsFrames.map((f) => [f.function, f.module, f.line])).toEqual([['parseConfig', 'entry', 8], ['aboutToAppear', 'entry', 14]]);
    // The JS frames count as evidence (upstream's pattern misses `at f entry (…)`).
    expect(v.evidence.some((e) => e.startsWith('JS frames'))).toBe(true);
  });

  it("reads a native crash from faultloggerd's crash record, with the ArkTS caller", () => {
    const text = fixture(RECORD);
    expect(isCrashJson(text)).toBe(true);
    const v = analyzeFaultLog(text);
    expect(v).toMatchObject({
      crashed: true,
      kind: 'cpp_crash',
      confidence: 'high',
      bundle: 'com.example.crashprobe',
      pid: 16917,
      uid: 20010066,
      tid: 16917,
      threadName: 'mple.crashprobe',
      time: '2026-11-05 12:39:01.472',
      reason: 'Signal:SIGSEGV(SEGV_MAPERR)@000000000000000000  probably caused by NULL pointer dereference',
      topFrame: '#00 pc 0000000000001ca0 /data/storage/el1/bundle/libs/arm64/libentry.so(1ab8a623d6767a8cf592d9b5cb302ca1a07fb29f)',
      file: 'entry/src/main/ets/pages/Index.ets',
      line: 12,
      column: 38,
      jsError: null,
    });
    expect(v.projectFrame).toBe('#04 at aboutToAppear entry (entry/src/main/ets/pages/Index.ets:12:38)');
    expect(v.nativeFrames[0]).toMatchObject({
      index: 0,
      pc: '0000000000001ca0',
      library: '/data/storage/el1/bundle/libs/arm64/libentry.so',
      symbol: null,
      buildId: '1ab8a623d6767a8cf592d9b5cb302ca1a07fb29f',
      area: 'app',
    });
    expect(v.nativeFrames[1]).toMatchObject({ library: '/root/system/lib64/platformsdk/libace_napi.z.so', area: 'system' });
    expect(v.notes[0]).toMatch(/crash record/);
  });

  it("reads a native service's cppcrash faultlog", () => {
    const v = analyzeFaultLog(fixture(SERVICE_CPP));
    expect(v).toMatchObject({
      kind: 'cpp_crash',
      confidence: 'high',
      bundle: 'blue_host',
      pid: 2468,
      tid: 2494,
      threadName: 'OS_IPC_1_2494',
      reason: 'Signal:SIGSEGV(SEGV_ACCERR)@0x0000007f23f27d50',
      projectFrame: null,
      file: null,
    });
    expect(v.topFrame).toMatch(/^#00 pc 000000000008ffec \/system\/lib\/ld-musl-aarch64\.so\.1\(do_dlsym\+492\)/);
    expect(v.nativeFrames).toHaveLength(19);
    expect(v.nativeFrames[2]).toMatchObject({
      library: '/vendor/lib64/libhci_interface_service_1.0.z.so',
      symbol: expect.stringMatching(/^OHOS::HDI::Bluetooth::Hci::V1_0::VendorInterface::Initialize\(.*\)\+604$/),
      buildId: '96a1267d54e4d18cfac302317a4322a0',
      area: 'system',
    });
  });

  it('reads an app freeze: event, blocked thread and the ArkTS frame it spins in', () => {
    const v = analyzeFaultLog(fixture(FREEZE));
    expect(v).toMatchObject({
      crashed: true,
      kind: 'app_freeze',
      subtype: 'THREAD_BLOCK_6S',
      confidence: 'high',
      bundle: 'com.example.crashprobe',
      pid: 17270,
      tid: 17270,
      threadName: 'mple.crashprobe',
      time: '2026-11-05 12:42:29',
      reason: 'THREAD_BLOCK_6S',
      topFrame: '#00 pc 0000000000000600 [vdso](__kernel_gettimeofday+44)',
      projectFrame: '#04 at anonymous (entry|entry|1.0.0|src/main/ets/pages/Index.ts:49:25)',
      file: 'entry|entry|1.0.0|src/main/ets/pages/Index.ts',
      line: 49,
      column: 25,
      binderChain: [],
    });
    // This build saves no binder info ("binder info is not saved in oversea version").
    expect(v.notes).toContain('The faulting process was in no synchronous binder call; the thread was not blocked on IPC.');
  });

  it("reads a system service's freeze", () => {
    const v = analyzeFaultLog(fixture(SYSFREEZE));
    expect(v).toMatchObject({ kind: 'app_freeze', subtype: 'SERVICE_BLOCK', bundle: 'render_service', pid: 2500, tid: 2500, reason: 'SERVICE_BLOCK' });
    expect(v.nativeFrames.length).toBeGreaterThan(0);
  });
});

// Written from upstream's test cases, not recorded: this device saves no binder info.
const BINDER_FREEZE = [
  'Module name:com.example.frozen',
  'Reason:THREAD_BLOCK_6S',
  'Pid:3456',
  'Process name:com.example.frozen',
  '***',
  'start time: 2026/09/01-12:00:06:000',
  'EVENTNAME = THREAD_BLOCK_6S',
  'PID = 3456',
  'TID = 3456',
  'PROCESS_NAME = com.example.frozen',
  'MSG = ',
  'Fault time:2026/09/01-12:00:00',
  'Tid:3456, Name:example.frozen',
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(__futex_wait+32)',
  '#01 pc 0000000000abcdef /system/lib64/platformsdk/libipc_core.z.so(OHOS::BinderInvoker::WaitForCompletion+100)',
  'Tid:3460, Name:OS_IPC_0_3460',
  '#00 pc 0000000000fedcba /system/lib/ld-musl-aarch64.so.1(ioctl+8)',
  '-------------------------------',
  'BinderCatcher --',
  '    3456:3456 to 1000:2000 code 5f475352 wait:6.5 s frz_state:3,',
  '    1000:2000 to 1001:3000 code 1234abcd wait:2.5 s',
  '    1001:3000 to 3456:3460 code 9 wait:2.0 s',
  '    3456:3460 to 1001:3000 code 7 wait:1.0 s',
  '    async 3456:3457 to 1002:2001 code abcd wait:0.1 s',
  'PeerBinder catcher stacktrace for pid : 1000',
  'Process name:com.example.peer',
  'Tid:2000, Name:binder_thread',
  'PeerBinder catcher stacktrace for pid : 1001',
  'Process name:/system/bin/foundation',
  'end time: 2026/09/01-12:00:07:000',
  '',
].join('\n');

describe('analyzeFaultLog on written logs', () => {
  it('follows the binder chain from the blocked thread, longest wait first, and finds the cycle', () => {
    const v = analyzeFaultLog(BINDER_FREEZE);
    expect(v.kind).toBe('app_freeze');
    expect(v.binderChain).toEqual([
      { from: '3456:3456(com.example.frozen/example.frozen)', to: '1000:2000(com.example.peer)', waitSeconds: 6.5, code: '5f475352', frzState: '3' },
      { from: '1000:2000(com.example.peer)', to: '1001:3000(foundation)', waitSeconds: 2.5, code: '1234abcd' },
      { from: '1001:3000(foundation)', to: '3456:3460(com.example.frozen/OS_IPC_0_3460)', waitSeconds: 2, code: '9' },
      { from: '3456:3460(com.example.frozen/OS_IPC_0_3460)', to: '1001:3000(foundation)', waitSeconds: 1, code: '7' },
    ]);
    expect(v.deadlocks).toHaveLength(1);
    expect(v.deadlocks[0]).toMatch(/1001:3000\(foundation\)/);
    expect(v.deadlocks[0]).toMatch(/3456:3460\(com\.example\.frozen\/OS_IPC_0_3460\)/);
  });

  it('reads an upstream-style JS crash fragment and the bare frame form', () => {
    const v = analyzeFaultLog('at foo (/data/storage/el1/bundle/ets/pages/Index.ets:10:15)\nat bar (entry/src/main/ets/pages/Index.ets:20:5)\n');
    expect(v).toMatchObject({ kind: 'js_crash', completeness: 'fragment', confidence: 'low', file: 'entry/src/main/ets/pages/Index.ets', line: 20 });
    expect(v.topFrame).toBe('at foo (/data/storage/el1/bundle/ets/pages/Index.ets:10:15)');
    expect(parseJsFrame('  at entry/src/main/ets/a.ets:1:2')).toMatchObject({ function: null, file: 'entry/src/main/ets/a.ets', line: 1, column: 2, project: true });
    expect(parseJsFrame('at f oh (entry/oh_modules/lib/src/main/x.ets:1:1)')?.project).toBe(false);
  });

  it('calls a mixed native and JS fragment a native crash', () => {
    const v = analyzeFaultLog('#00 pc 0000000000001234 /data/storage/el1/bundle/libs/arm64/libentry.so(Add+12)\n#01 at add entry (entry/src/main/ets/pages/Index.ets:3:4)\n');
    expect(v).toMatchObject({ kind: 'cpp_crash', confidence: 'medium', completeness: 'fragment', file: 'entry/src/main/ets/pages/Index.ets', line: 3 });
    expect(v.projectFrame).toBe('#01 at add entry (entry/src/main/ets/pages/Index.ets:3:4)');
  });

  it('classifies a sample stack, a hilog stream and an empty input as no crash', () => {
    const sample = classifyFaultLog('#Basic Statistical\nStaticsDuration: 5000 ms\nSnapshotTime: 2026-09-01 12:00:00\n#00 pc 0000000000001234 /system/lib/libc.so\n');
    expect(sample).toMatchObject({ kind: 'sample_stack', confidence: 'high' });
    expect(analyzeFaultLog('#Basic Statistical\nStaticsDuration: 5000 ms\n').crashed).toBe(false);
    const hilog = analyzeFaultLog('11-05 12:32:58.078  2695  2695 I C01406/RS: one\n11-05 12:32:58.079  2695  3012 I C01406/RS: two\n');
    expect(hilog).toMatchObject({ crashed: false, kind: 'unknown' });
    expect(hilog.notes).toContain('The input is a HiLog stream, not a faultlog.');
    expect(classifyFaultLog('').outOfScope?.reason).toBe('empty');
  });

  it('reports a GWP-ASan report and the last fatal message', () => {
    const v = analyzeFaultLog([
      'Pid:1234', 'Process name:com.example.app', 'Timestamp:2026-09-01 10:00:00.000', 'Process life time:10s',
      'Reason:Signal:SIGABRT(SI_TKILL)', 'LastFatalMessage:boom', 'Fault thread info:', 'Tid:1234, Name:example.app',
      '#00 pc 0000000000000010 /system/lib/ld-musl-aarch64.so.1(raise+8)', 'Registers:', 'x0:0',
      '*** GWP-ASan detected a memory error ***', 'use-after-free', '* End GWP-ASan report *', '',
    ].join('\n'));
    expect(v).toMatchObject({ kind: 'cpp_crash', lastFatalMessage: 'boom', gwpAsan: '*** GWP-ASan detected a memory error ***\nuse-after-free\n* End GWP-ASan report *' });
  });

  it('reads native frames with and without a symbol or build id', () => {
    expect(parseNativeFrame('#03 pc 0000000000e9f528 /root/system/lib64/module/arkcompiler/stub.an')).toMatchObject({
      index: 3, library: '/root/system/lib64/module/arkcompiler/stub.an', symbol: null, buildId: null, area: 'system',
    });
    expect(parseNativeFrame('#00 pc 0000000000000600 [vdso](__kernel_gettimeofday+44)')).toMatchObject({ library: '[vdso]', symbol: '__kernel_gettimeofday+44', area: 'other' });
    expect(parseNativeFrame('at foo (a.ets:1:1)')).toBeNull();
  });
});

describe('faultlog listing parsers', () => {
  const LIST = `${BANNER}Fault log list:\n******\n${JS}\n${SERVICE_CPP}\n******\n`;

  it('reads the hidumper list and file names', () => {
    expect(parseFaultLogList(LIST)).toEqual([JS, SERVICE_CPP]);
    expect(parseFaultLogList(`${BANNER}No fault log exist.\nFault log list:\n******\n******\n`)).toEqual([]);
    expect(parseFaultLogList('hidumper: no such service')).toBeNull();
    expect(parseFaultLogName(JS, 60)).toEqual({
      name: JS,
      path: `/data/log/faultlog/faultlogger/${JS}`,
      source: 'faultlogger',
      type: 'jscrash',
      module: 'com.example.crashprobe',
      pid: null,
      uid: 20010066,
      time: '2026-11-05 12:32:57.298',
      epochMs: Date.parse('2026-11-05T11:32:57.298Z'),
    });
    // `-l` without `-LogSuffixWithMs` drops the milliseconds and the extension.
    expect(parseFaultLogName('cppcrash-render_service-1003-20261023180912')).toMatchObject({ module: 'render_service', time: '2026-10-23 18:09:12.000', epochMs: null });
    expect(parseFaultLogName('not-a-faultlog')).toBeNull();
    expect(parseUtcOffset('+0100')).toBe(60);
    expect(parseUtcOffset('-0530')).toBe(-330);
  });

  it('strips the hidumper banner', () => {
    expect(stripHidumperBanner(`${BANNER}Generated by HiviewDFX@OpenHarmony\n`)).toBe('Generated by HiviewDFX@OpenHarmony\n');
  });

  it('reads crash record heads', () => {
    const head = fixture(RECORD).slice(0, 512);
    expect(parseCrashRecordHeads(`== /data/log/faultlog/temp/${RECORD}\n${head}\n`)).toEqual([{
      name: RECORD,
      path: `/data/log/faultlog/temp/${RECORD}`,
      source: 'temp',
      type: 'cppcrash',
      module: 'com.example.crashprobe',
      pid: 16917,
      uid: 20010066,
      time: '2026-11-05 12:39:01.472',
      epochMs: 1793878741472,
    }]);
  });
});

// hdc is a shell-script stand-in that answers each command the lookup sends.
describe.skipIf(process.platform === 'win32')('latestCrash against a stand-in hdc', () => {
  let tmp: string;
  let log: string;

  /** `listed`: faultlogs hidumper lists; `records`: crash records in temp; `dumpFails`: `-f` prints nothing. */
  const fakeHdc = (opts: { listed: string[]; records?: string[]; dumpFails?: boolean; noHidumper?: boolean }) => {
    const hdc = path.join(tmp, 'hdc');
    const list = opts.listed.join('\\n');
    const records = (opts.records ?? []).map((r) => `echo "== /data/log/faultlog/temp/${r}"; head -c 512 "${FIXTURES}/${r}"; echo`).join('; ');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
echo "$*" >> "${log}"
cmd="$2"
case "$cmd" in
  "date '+%s %z'") echo "1793878300 +0100" ;;
  *"-p Faultlogger -LogSuffixWithMs"*)
    ${opts.noHidumper ? 'echo "hidumper: unknown option"' : `printf '${BANNER.replace(/\n/g, '\\n')}Fault log list:\\n******\\n${list}${list ? '\\n' : ''}******\\n'`} ;;
  "ls /data/log/faultlog/faultlogger") printf '${list}\\n' ;;
  "for f in"*) ${records || 'true'} ;;
  *"-p Faultlogger -f "*)
    ${opts.dumpFails ? 'true' : `name=\${cmd##*-f }; name=\${name%\\'}; printf '${BANNER.replace(/\n/g, '\\n')}'; cat "${FIXTURES}/$name"`} ;;
  "cat /data/log/faultlog/"*) cat "${FIXTURES}/\${cmd##*/}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    return staticConfig({ hdcPath: hdc });
  };
  const calls = (): string[] => fs.readFileSync(log, 'utf8').trim().split('\n');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-faultlog-'));
    log = path.join(tmp, 'hdc.log');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns the bundle's newest fault, read through hidumper", async () => {
    const config = fakeHdc({ listed: [FREEZE, SERVICE_CPP, JS], records: [RECORD] });
    const v = await latestCrash({ config, bundle: 'com.example.crashprobe' });
    expect(v).toMatchObject({ kind: 'app_freeze', name: FREEZE, path: `/data/log/faultlog/faultlogger/${FREEZE}` });
    expect(calls()).toContain(`shell hidumper -s 1201 -a '-p Faultlogger -f ${FREEZE}'`);
  });

  it('applies since, as an instant or as seconds before the device clock', async () => {
    const config = fakeHdc({ listed: [JS], records: [RECORD] });
    // 12:35 CET: after the JS crash (12:32:57), before the native one (12:39:01).
    const v = await latestCrash({ config, bundle: 'com.example.crashprobe', since: new Date('2026-11-05T11:35:00Z') });
    expect(v).toMatchObject({ kind: 'cpp_crash', name: RECORD, path: `/data/log/faultlog/temp/${RECORD}`, file: 'entry/src/main/ets/pages/Index.ets' });
    expect(calls()).toContain(`shell cat /data/log/faultlog/temp/${RECORD}`);

    // The device clock reads 12:31:40 CET; 60 s back is before both.
    expect((await latestCrash({ config, bundle: 'com.example.crashprobe', since: 60 }))?.name).toBe(RECORD);
    expect(await latestCrash({ config, bundle: 'com.example.crashprobe', since: new Date('2026-11-05T12:00:00Z') })).toBeNull();
  });

  it('drops a crash record hiview already turned into a faultlog', async () => {
    const record = 'cppcrash-2468-1793707050374.json';
    fs.writeFileSync(path.join(tmp, record), '');
    const entries = parseCrashRecordHeads(`== /data/log/faultlog/temp/${record}\n{"JSON_VERSION":"1.0","TIMESTAMP":"2026-11-03 12:57:30.374\\n","PID":2468,"UID":3021,"PNAME":"blue_host"`);
    expect(entries[0]).toMatchObject({ module: 'blue_host', time: '2026-11-03 12:57:30.374' });
    const config = fakeHdc({ listed: [SERVICE_CPP], records: [RECORD] });
    const all = await listFaultLogs({ config });
    expect(all.map((e) => e.name)).toEqual([RECORD, SERVICE_CPP]);
    expect(all.find((e) => e.module === 'blue_host')?.source).toBe('faultlogger');
  });

  it('falls back to cat when hidumper cannot print the file, and to ls when it cannot list', async () => {
    let config = fakeHdc({ listed: [JS], dumpFails: true });
    expect((await latestCrash({ config, bundle: 'com.example.crashprobe' }))?.kind).toBe('js_crash');
    expect(calls()).toContain(`shell cat /data/log/faultlog/faultlogger/${JS}`);
    fs.rmSync(log);
    config = fakeHdc({ listed: [JS], noHidumper: true });
    expect((await listFaultLogs({ config })).map((e) => e.name)).toEqual([JS]);
    expect(calls()).toContain('shell ls /data/log/faultlog/faultlogger');
  });

  it('saves the faultlog when asked', async () => {
    const config = fakeHdc({ listed: [JS] });
    const saveDir = path.join(tmp, 'saved');
    const v = await latestCrash({ config, bundle: 'com.example.crashprobe', saveDir });
    expect(v?.rawPath).toBe(path.join(saveDir, JS));
    expect(fs.readFileSync(v!.rawPath!, 'utf8')).toBe(fixture(JS));
  });

  it('returns null when the bundle has no fault, after waiting when asked', async () => {
    const config = fakeHdc({ listed: [JS], records: [RECORD] });
    const started = Date.now();
    expect(await latestCrash({ config, bundle: 'com.example.other', waitMs: 300, pollMs: 100 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(calls().filter((c) => c.includes('-LogSuffixWithMs')).length).toBeGreaterThan(1);
  });
});
