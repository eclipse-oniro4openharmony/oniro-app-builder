import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { perfTrace } from '../src/perf/perfTrace.js';
import { fakePerfDevice, PERF_APP as APP, type FakePerfDevice } from './_helpers/perfDevice.js';

const isWin = process.platform === 'win32';

describe.skipIf(isWin)('perfTrace (stand-in hdc)', () => {
  let dev: FakePerfDevice;
  const opts = () => ({ config: staticConfig({ hdcPath: dev.hdc }), bundle: APP, wake: false, forMs: 10 });

  beforeEach(() => {
    dev = fakePerfDevice();
  });
  afterEach(() => dev.cleanup());

  it('stops the app, starts tracing, cold-launches it, pulls the trace and summarises it', async () => {
    const out = path.join(dev.root, 'out', 'trace.ftrace');
    const r = await perfTrace({ ...opts(), launch: true, ability: 'EntryAbility', out });
    expect(r).toMatchObject({ ok: true, bundle: APP, pid: 22334, trace: out, refreshRateHz: 60.6, flow: null });
    expect(r.frames).toMatchObject({ total: 200, janky: 28 });
    expect(r.startup).toMatchObject({ coldMs: 778, from: 'aa StartAbility' });
    expect(r.error).toBeUndefined();
    expect(fs.existsSync(out)).toBe(true);
    const cmds = dev.commands();
    const at = (re: RegExp) => cmds.findIndex((c) => re.test(c));
    expect(cmds[at(/^hitrace --trace_begin/)]).toBe('hitrace --trace_begin -b 65536 ace app graphic ability window');
    expect(at(/^aa force-stop com\.example\.perfprobe/)).toBeLessThan(at(/^hitrace --trace_begin/));
    expect(at(/^hitrace --trace_begin/)).toBeLessThan(at(/^aa start -a EntryAbility -b com\.example\.perfprobe/));
    expect(at(/^aa start/)).toBeLessThan(at(/^hitrace --trace_finish -o \/data\/local\/tmp\/oniro_perf_\d+\.ftrace$/));
    expect(at(/^rm -f \/data\/local\/tmp\/oniro_perf_/)).toBeGreaterThan(at(/^hitrace --trace_finish -o/));
    expect(at(/--trace_finish_nodump/)).toBe(-1);
  });

  it('takes over a capture left running, with a note', async () => {
    fs.writeFileSync(path.join(dev.root, 'busy'), '');
    const r = await perfTrace(opts());
    expect(r.ok).toBe(true);
    expect(r.notes[0]).toMatch(/already running on the device; it was stopped/);
    expect(r.startup).toBeNull();
    expect(dev.commands().filter((c) => c.startsWith('hitrace --trace_begin'))).toHaveLength(2);
  });

  it('reports a capture that could not start, and leaves nothing behind', async () => {
    const r = await perfTrace({ ...opts(), categories: ['ace', 'bogus'] });
    expect(r).toMatchObject({ ok: false, trace: null, frames: null });
    expect(r.error).toMatch(/hitrace could not start: .*bogus is not support category/);
    expect(dev.commands().some((c) => c.startsWith('rm -f /data/local/tmp/oniro_perf_'))).toBe(true);
  });

  it('refuses without a bundle, with a bad category, or without a device', async () => {
    expect((await perfTrace({ ...opts(), bundle: undefined })).error).toMatch(/No bundle to measure/);
    expect((await perfTrace({ ...opts(), categories: ['ace;reboot'] })).error).toMatch(/Not a hitrace category: ace;reboot/);
    fs.writeFileSync(path.join(dev.root, 'targets.txt'), '[Empty]\n');
    expect((await perfTrace(opts())).error).toMatch(/No connected device/);
    expect(dev.commands()).toEqual([]);
  });
});
