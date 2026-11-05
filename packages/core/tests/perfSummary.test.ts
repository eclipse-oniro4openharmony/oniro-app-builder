import { describe, expect, it } from 'vitest';
import { cleanMarkerName, parseTraceFile, parseTraceText } from '../src/perf/hitrace.js';
import { commMatchesBundle, perfSliceFilter, quantile, summarizeTrace } from '../src/perf/summary.js';
import { parseHiperfReport } from '../src/perf/hiperf.js';
import { evaluatePerfGate, parseActiveRefreshRate } from '../src/perf/perfTrace.js';
import { PERF_APP, PERF_FIXTURE } from './_helpers/perfDevice.js';

const FIXTURE = PERF_FIXTURE;
const APP = PERF_APP;

const HEADER = `# tracer: nop
#
# entries-in-buffer/entries-written: 10/14   #P:8
#
#           TASK-PID       TGID    CPU#  |||||  TIMESTAMP  FUNCTION
`;

/** One tracing_mark_write line. */
const mark = (comm: string, tid: number, tgid: number, sec: number, body: string): string =>
  `${comm.padStart(16)}-${tid}   (${String(tgid).padStart(7)}) [001] ..... ${sec.toFixed(6)}: tracing_mark_write: ${body}`;

describe('hitrace text parser', () => {
  it('strips the H: and HiTraceChain prefixes', () => {
    expect(cleanMarkerName('H:[a92ab18be48d19e,27224d3,0]#virtual int Foo::StartAbility()')).toBe('virtual int Foo::StartAbility()');
    expect(cleanMarkerName('H:ReceiveVsync name:WM_1')).toBe('ReceiveVsync name:WM_1');
    expect(cleanMarkerName('plain')).toBe('plain');
  });

  it('pairs B/E per thread, with and without the level suffix, and keeps async slices, counters and sched time', () => {
    const text = [
      HEADER,
      mark('ample.perfprobe', 100, 100, 10.0, 'E|100|I39'), // began before the capture: ignored
      mark('ample.perfprobe', 100, 100, 10.001, 'B|100|H:Outer|I39'),
      mark('ample.perfprobe', 100, 100, 10.002, 'B|100|H:Inner a|b|M0538'),
      mark('OS_IPC_1', 101, 100, 10.0025, 'B|100|H:OtherThread'),
      mark('ample.perfprobe', 100, 100, 10.004, 'E|100|M0538'),
      mark('ample.perfprobe', 100, 100, 10.011, 'E|100|I39'),
      mark('OS_IPC_1', 101, 100, 10.012, 'E|100'),
      mark('render_service', 7, 7, 10.02, 'S|7|H:APP_LIST_FLING, com.example.perfprobe|42|M0538'),
      mark('render_service', 7, 7, 10.05, 'F|7|H:APP_LIST_FLING, com.example.perfprobe|42|M0538'),
      mark('render_service', 7, 7, 10.06, 'C|7|H:JANK_FRAME_1-5F|2|M0538'),
      mark('ample.perfprobe', 100, 100, 10.07, 'B|100|H:Unclosed'),
      '          <idle>-0       (-------) [001] d..2. 10.003000: sched_switch: prev_comm=swapper/1 prev_pid=0 prev_prio=120 prev_state=R ==> next_comm=ample.perfprobe next_pid=100 next_prio=120',
      ` ample.perfprobe-100     (    100) [001] d..2. 10.008000: sched_switch: prev_comm=ample.perfprobe prev_pid=100 prev_prio=120 prev_state=S ==> next_comm=swapper/1 next_pid=0 next_prio=120`,
      // No tgid column (older ftrace output).
      '        hilogd-55    [002] .... 10.09: tracing_mark_write: B|55|H:NoTgid',
      '        hilogd-55    [002] .... 10.10: tracing_mark_write: E|55|',
    ].join('\n');
    const m = parseTraceText(text);
    expect(m.entriesInBuffer).toBe(10);
    expect(m.entriesWritten).toBe(14);
    expect(m.startMs).toBe(10_000);
    expect(m.endMs).toBe(10_100);
    const byName = Object.fromEntries(m.slices.map((s) => [s.name, s]));
    expect(byName['Outer']).toMatchObject({ tid: 100, pid: 100, depth: 0 });
    expect(byName['Outer']!.dur).toBeCloseTo(10, 6);
    expect(byName['Inner a|b']).toMatchObject({ depth: 1 });
    expect(byName['Inner a|b']!.dur).toBeCloseTo(2, 6);
    expect(byName['OtherThread']).toMatchObject({ tid: 101, pid: 100, depth: 0 });
    expect(byName['Unclosed']!.dur).toBeUndefined();
    expect(byName['NoTgid']).toMatchObject({ tid: 55, pid: 55 });
    expect(m.asyncSlices).toEqual([{ pid: 7, name: 'APP_LIST_FLING, com.example.perfprobe', cookie: '42', ts: 10_020, dur: expect.closeTo(30, 6) }]);
    expect(m.counters).toEqual([{ pid: 7, name: 'JANK_FRAME_1-5F', ts: 10_060, value: 2 }]);
    expect(m.schedSwitchCount).toBe(2);
    expect(m.mainThreadCpuMs.get(100)).toBeCloseTo(5, 6);
    expect(m.threads.get(100)).toEqual({ comm: 'ample.perfprobe', pid: 100 });
  });

  it('keepSlice drops what the summary does not need', () => {
    const text = [
      mark('ample.perfprobe', 100, 100, 1.0, 'B|100|H:ReceiveVsync now:1'),
      mark('ample.perfprobe', 100, 100, 1.001, 'B|100|H:Noise'),
      mark('ample.perfprobe', 100, 100, 1.002, 'E|100'),
      mark('ample.perfprobe', 100, 100, 1.003, 'E|100'),
      mark('worker', 101, 100, 1.004, 'B|100|H:Noise'),
      mark('worker', 101, 100, 1.005, 'E|100'),
    ].join('\n');
    expect(parseTraceText(text, { keepSlice: perfSliceFilter }).slices.map((s) => s.name)).toEqual(['ReceiveVsync now:1']);
  });
});

describe('summarizeTrace on a real capture', () => {
  it('reports frames, jank, startup and the RenderService scene for a cold launch', async () => {
    const model = await parseTraceFile(FIXTURE, { keepSlice: perfSliceFilter });
    const s = summarizeTrace(model, { bundle: APP, launched: true });
    expect(s.pid).toBe(22334);
    expect(s.refreshRateHz).toBe(60.6);
    expect(s.frames).toMatchObject({ total: 200, janky: 28, jankRate: 0.14, p50Ms: 4.7, p95Ms: 20.5, maxMs: 592.6, missedVsyncs: 68 });
    // The 600 ms button handler is the longest frame.
    expect(s.frames.longest[0]).toEqual({ atMs: 6501.3, ms: 592.6 });
    expect(s.startup).toEqual({
      coldMs: 778,
      firstFrameMs: 151.4,
      processMs: 30.5,
      from: 'aa StartAbility',
      to: 'first frame composited (RSJankStats::ReportEventFirstFrame)',
    });
    expect(s.mainThread.cpuMs).toBeNull();
    expect(s.mainThread.busyMs).toBeGreaterThan(1000);
    expect(s.scenes).toEqual([
      expect.objectContaining({ scene: 'APP_LIST_FLING', page: '/ets/pages/Index', maxFrameMs: expect.any(Number), hitchMsPerS: expect.any(Number) }),
    ]);
    expect(s.notes).toEqual(['The first frame after launch is reported under startup, not in the frame stats.']);
  });

  it('without launched keeps the first frame and reports no startup', async () => {
    const s = summarizeTrace(await parseTraceFile(FIXTURE, { keepSlice: perfSliceFilter }), { bundle: APP });
    expect(s.startup).toBeNull();
    expect(s.frames.total).toBe(201);
  });

  it('says so when the bundle is not in the trace', async () => {
    const s = summarizeTrace(await parseTraceFile(FIXTURE), { bundle: 'com.example.other', refreshRateHz: 90 });
    expect(s.pid).toBeNull();
    expect(s.frames.total).toBe(0);
    expect(s.notes).toContain('No process of com.example.other in the trace.');
  });
});

describe('summarizeTrace edge cases', () => {
  const frame = (tid: number, sec: number, durMs: number, vsyncSec = sec - 0.001): string[] => [
    mark('<...>', tid, tid, sec, `B|${tid}|H:ReceiveVsync name:WM_${tid} now:${Math.round(vsyncSec * 1e9)} expectedEnd: 0 vsyncId:1, fd:26|M0538`),
    mark('<...>', tid, tid, sec + durMs / 1000, `E|${tid}|M0538`),
  ];

  it('finds the app by its RenderService surface when thread names are missing, and falls back on the given refresh rate', () => {
    const text = [
      mark('RSMainThread', 9, 9, 1.0, 'B|9|H:RSUniRender::QuickPrepare:[perfprobe0] nodeId[123] pid[300] nodeType[1] subTreeDirty[0]|M0538'),
      mark('RSMainThread', 9, 9, 1.0001, 'E|9|M0538'),
      ...frame(300, 1.1, 5),
      ...frame(300, 1.2, 30),
      ...frame(300, 1.3, 2, 1.25), // waited 50 ms for the main thread: janky though short
    ].join('\n');
    const s = summarizeTrace(parseTraceText(text, { keepSlice: perfSliceFilter }), { bundle: APP, refreshRateHz: 50 });
    expect(s.pid).toBe(300);
    expect(s.refreshRateHz).toBe(50);
    expect(s.frames).toMatchObject({ total: 3, janky: 2, maxMs: 52, missedVsyncs: 1 + 2 });
    expect(s.notes[0]).toMatch(/found from its RenderService surface \(pid 300\)/);
  });

  it('assumes 60 Hz with a note when nothing gives the rate, and notes buffer overflow', () => {
    const text = [HEADER, mark('ample.perfprobe', 300, 300, 1.0, 'B|300|H:ReceiveVsync now:999000000'), mark('ample.perfprobe', 300, 300, 1.01, 'E|300')].join('\n');
    const s = summarizeTrace(parseTraceText(text), { bundle: APP });
    expect(s.refreshRateHz).toBe(60);
    expect(s.notes.join('\n')).toMatch(/overflowed \(4 of 14 events lost\)/);
    expect(s.notes.join('\n')).toMatch(/assumed 60 Hz/);
  });

  it('matches the comm the kernel keeps for an app main thread', () => {
    expect(commMatchesBundle('ample.perfprobe', APP)).toBe(true);
    expect(commMatchesBundle('com.example.per', APP)).toBe(true);
    expect(commMatchesBundle('perfprobe', APP)).toBe(false);
    expect(commMatchesBundle('com.x', 'com.x')).toBe(true);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('gate, hiperf and hidumper helpers', () => {
  const frames = { total: 100, janky: 10, jankRate: 0.1, p50Ms: 5, p95Ms: 20, maxMs: 40, missedVsyncs: 12, longest: [] };
  const startup = { coldMs: 800, firstFrameMs: 50, processMs: 30, from: 'aa StartAbility', to: 'x' };

  it('fails a threshold that is exceeded or that has nothing to measure', () => {
    expect(evaluatePerfGate({ frames, startup, flow: null }, {})).toEqual({ passed: true, failures: [] });
    expect(evaluatePerfGate({ frames, startup, flow: null }, { maxJankRate: 0.1, maxStartupMs: 800 }).passed).toBe(true);
    expect(evaluatePerfGate({ frames, startup, flow: null }, { maxJankRate: 0.05, maxStartupMs: 500 }).failures).toEqual([
      'Jank rate 0.1 (10/100 frames) is above 0.05.',
      'Cold start 800 ms is above 500 ms.',
    ]);
    expect(evaluatePerfGate({ frames: { ...frames, total: 0 }, startup: null, flow: null }, { maxJankRate: 1, maxStartupMs: 1 }).failures).toEqual([
      'No frames were captured to judge the jank rate.',
      'No startup time was measured (use --launch).',
    ]);
    const diverged = { ok: false, outcome: 'diverged' as const, range: [0, 1] as [number, number], steps: [], warnings: [], failedStep: 1 };
    expect(evaluatePerfGate({ frames, startup, flow: diverged }, {}).failures[0]).toMatch(/did not complete \(diverged at step 1\)/);
  });

  it('parses hiperf report rows and the active refresh rate', () => {
    const r = parseHiperfReport(
      [
        'Event: hw-cpu-cycles (type 0 id 0)',
        'Samples Count: 25',
        'Event Count: 20091',
        'Heating count dso                              func                                      ',
        '39.16%   7868 [kernel.kallsyms]                _raw_spin_unlock_irqrestore               ',
        ' 2.44%    199 /system/lib64/platformsdk/libace_compatible.z.so OHOS::Ace::NG::UINode::TotalChildCount() const',
        'report done',
      ].join('\n'),
    );
    expect(r).toEqual({
      event: 'hw-cpu-cycles',
      samples: 25,
      top: [
        { percent: 39.16, dso: '[kernel.kallsyms]', func: '_raw_spin_unlock_irqrestore' },
        { percent: 2.44, dso: '/system/lib64/platformsdk/libace_compatible.z.so', func: 'OHOS::Ace::NG::UINode::TotalChildCount() const' },
      ],
    });
    expect(parseActiveRefreshRate('supportedMode[0]: 1080x2400, refreshRate=59\nactiveMode: 1080x2400, refreshRate=59\n')).toBe(59);
    expect(parseActiveRefreshRate('nothing')).toBeNull();
  });
});
