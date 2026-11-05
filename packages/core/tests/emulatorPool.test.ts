import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import {
  EMULATOR_KERNEL_APPEND,
  buildPoolQemuArgs,
  classifyEmulatorHealth,
  emulatorAccelArgs,
  getPoolInstanceStatus,
  listPoolInstanceStatuses,
  poolInstancePorts,
  startPoolInstance,
  stopPoolInstance,
} from '../src/emulator/pool.js';
import { isInstanceProcess, livePoolPids, poolInstanceDir, readPoolState } from '../src/emulator/state.js';
import { startEmulator } from '../src/emulator/lifecycle.js';

const isWin = process.platform === 'win32';

describe('poolInstancePorts', () => {
  it('derives hdc 55555+n, VNC display n (5900+n) and serial 4444+n', () => {
    expect(poolInstancePorts(1)).toEqual({ hdc: 55556, vncDisplay: 1, vnc: 5901, serial: 4445 });
    expect(poolInstancePorts(12)).toEqual({ hdc: 55567, vncDisplay: 12, vnc: 5912, serial: 4456 });
  });

  it('rejects 0 (the default emulator), negatives, fractions and > 99', () => {
    for (const n of [0, -1, 1.5, 100]) expect(() => poolInstancePorts(n)).toThrow(/1 to 99/);
  });
});

describe('emulatorAccelArgs', () => {
  it('picks the accelerator run.sh picks per host', () => {
    expect(emulatorAccelArgs('auto', 'linux', 'x64')).toEqual(['-enable-kvm', '-cpu', 'host']);
    expect(emulatorAccelArgs('auto', 'darwin', 'x64')).toEqual(['-accel', 'hvf', '-cpu', 'host']);
    expect(emulatorAccelArgs('auto', 'darwin', 'arm64')).toEqual(['-accel', 'tcg,thread=multi', '-cpu', 'max']);
    expect(emulatorAccelArgs('auto', 'win32', 'x64')).toEqual(['-accel', 'whpx']);
    expect(emulatorAccelArgs('tcg', 'linux', 'x64')).toEqual(['-accel', 'tcg,thread=multi', '-cpu', 'max']);
  });
});

describe('buildPoolQemuArgs', () => {
  const spec = {
    instance: 3,
    dir: '/state/3',
    imagesDir: '/emu/images',
    smp: 2,
    memory: '2048M',
    resolution: '360x720',
    headless: true,
    audioDevice: 'es1370',
    accelArgs: ['-enable-kvm', '-cpu', 'host'],
    ports: poolInstancePorts(3),
  };

  it('mirrors run.sh with the disks swapped for the instance overlays and ports at the instance number', () => {
    const args = buildPoolQemuArgs(spec);
    const joined = args.join(' ');
    expect(joined).toContain('-machine q35 -smp 2 -m 2048M -boot c');
    expect(joined).toContain('-display vnc=127.0.0.1:3');
    expect(joined).toContain('-serial telnet:127.0.0.1:4447,server,nowait');
    expect(joined).toContain('-netdev user,id=net0,hostfwd=tcp:127.0.0.1:55558-:55555');
    expect(args).toContain(path.join('/emu/images', 'bzImage'));
    expect(args).toContain(path.join('/emu/images', 'ramdisk.img'));
    expect(args[args.indexOf('-append') + 1]).toBe(EMULATOR_KERNEL_APPEND);
    // vda..vdd in run.sh's order: the kernel command line names vda/vdb/vdc by position.
    const drives = args.filter((a) => a.startsWith('if=none'));
    expect(drives).toEqual(
      ['updater', 'system', 'vendor', 'userdata'].map(
        (d, i) => `if=none,file=${path.join('/state/3', `${d}.qcow2`)},format=qcow2,id=${d},index=${i}`,
      ),
    );
    expect(joined).not.toMatch(/\.img,format=raw/);
  });

  it('doubles commas in overlay paths and uses SDL when not headless', () => {
    const args = buildPoolQemuArgs({ ...spec, dir: '/a,b', headless: false });
    expect(args).toContain(`if=none,file=${path.join('/a,,b', 'userdata.qcow2')},format=qcow2,id=userdata,index=3`);
    expect(args).toContain('sdl,gl=off');
  });
});

describe('classifyEmulatorHealth', () => {
  const base = { alive: true, hdcReachable: false, bootCompleted: false, wasReady: false, elapsedMs: 10_000, bootTimeoutMs: 300_000 };
  it.each([
    [{ alive: false }, 'stopped'],
    [{}, 'booting'],
    [{ hdcReachable: true }, 'booting'],
    [{ hdcReachable: true, bootCompleted: true }, 'ready'],
    [{ wasReady: true }, 'hdc-lost'],
    [{ wasReady: true, hdcReachable: true }, 'booting'],
    [{ elapsedMs: 400_000 }, 'stuck'],
    [{ elapsedMs: 400_000, hdcReachable: true }, 'stuck'],
    [{ elapsedMs: undefined }, 'booting'],
  ] as const)('%o -> %s', (over, want) => {
    expect(classifyEmulatorHealth({ ...base, ...over })).toBe(want);
  });
});

// Stand-ins: a `qemu-system-x86_64` that records its argv and idles until SIGTERM
// (or exits at once with a lock error when `qemu.fail` exists), a `qemu-img` that
// records its argv and creates the overlay, and an `hdc` whose answer to
// `param get bootevent.boot.completed` comes from `boot.state` (`true`, `false`, or
// `down` for an unreachable guest), recording every call.
describe.skipIf(isWin)('pool instances (stand-in qemu, qemu-img and hdc)', () => {
  let root: string;
  let emulatorDir: string;
  let bin: string;
  const started: number[] = [];
  // High instance numbers keep the stand-ins clear of real pool instances' ports.
  const N = 91;

  const write = (file: string, body: string): void => {
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  };
  const config = () => staticConfig({ emulatorDir, hdcPath: path.join(bin, 'hdc') });
  const setBoot = (s: 'true' | 'false' | 'down'): void => fs.writeFileSync(path.join(root, 'boot.state'), s);
  const lines = (name: string): string[] => {
    const f = path.join(root, name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
  };
  const start = async (n: number, extra: Partial<Parameters<typeof startPoolInstance>[0]> = {}) => {
    const st = await startPoolInstance({
      config: config(),
      instance: n,
      qemuBin: path.join(bin, 'qemu-system-x86_64'),
      accel: 'tcg',
      earlyExitWindowMs: 300,
      ...extra,
    });
    started.push(n);
    return st;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-pool-'));
    emulatorDir = path.join(root, 'emu');
    bin = path.join(root, 'bin');
    fs.mkdirSync(path.join(emulatorDir, 'images'), { recursive: true });
    fs.mkdirSync(bin);
    for (const f of ['bzImage', 'ramdisk.img', 'updater.img', 'system.img', 'vendor.img', 'userdata.img']) {
      fs.writeFileSync(path.join(emulatorDir, 'images', f), `${f}\n`);
    }
    write(
      path.join(bin, 'qemu-system-x86_64'),
      `#!/bin/sh
if [ "$1" = "-device" ] && [ "$2" = "help" ]; then echo 'name "es1370", bus PCI'; exit 0; fi
if [ -e '${root}/qemu.fail' ]; then echo 'qemu-system-x86_64: Failed to get "write" lock' >&2; exit 1; fi
echo "$*" >> '${root}/qemu.args'
trap 'kill $! 2>/dev/null; exit 0' TERM
sleep 300 &
wait
`,
    );
    write(
      path.join(bin, 'qemu-img'),
      `#!/bin/sh
echo "$*" >> '${root}/qemu-img.args'
for a in "$@"; do case "$a" in *.qcow2) echo overlay > "$a";; esac; done
exit 0
`,
    );
    write(
      path.join(bin, 'hdc'),
      `#!/bin/sh
echo "$*" >> '${root}/hdc.calls'
if [ "$1" = "-t" ]; then shift 2; fi
case "$1" in
  tconn) echo 'Connect OK'; exit 0 ;;
  shell)
    s=$(cat '${root}/boot.state' 2>/dev/null || echo false)
    if [ "$s" = down ]; then echo '[Fail]Connect server failed'; exit 0; fi
    echo "$s"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    );
    setBoot('false');
  });

  afterEach(async () => {
    for (const n of started.splice(0)) await stopPoolInstance({ config: config(), instance: n }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates overlays backed read-only by the raw images and launches QEMU on them', async () => {
    const st = await start(N);
    expect(st.state).toBe('booting');
    expect(st.address).toBe('127.0.0.1:55646');
    const dir = poolInstanceDir(config(), N);
    expect(st.dir).toBe(dir);

    const imgArgs = lines('qemu-img.args');
    expect(imgArgs).toHaveLength(4);
    for (const d of ['updater', 'system', 'vendor', 'userdata']) {
      const base = path.join(emulatorDir, 'images', `${d}.img`);
      expect(imgArgs).toContainEqual(`create -q -f qcow2 -F raw -b ${base} -u ${path.join(dir, `${d}.qcow2`)} ${d.length + 5}`);
    }
    const [qemuArgs] = lines('qemu.args');
    expect(qemuArgs).toContain(`file=${path.join(dir, 'userdata.qcow2')},format=qcow2`);
    expect(qemuArgs).toContain('hostfwd=tcp:127.0.0.1:55646-:55555');
    expect(qemuArgs).toContain('-device es1370,audiodev=snd0');
    expect(qemuArgs).not.toContain('format=raw');

    const state = readPoolState(dir)!;
    expect(isInstanceProcess(state.pid, dir)).toBe(true);
    expect(state.bases!['userdata.img']!.size).toBe('userdata.img\n'.length);
    expect(livePoolPids(config()).get(N)).toBe(state.pid);
  });

  it('reports booting, then ready (recorded), then hdc-lost, then stopped; never restarts the hdc server', async () => {
    await start(N);
    expect((await getPoolInstanceStatus(config(), N)).state).toBe('booting');
    setBoot('true');
    const ready = await getPoolInstanceStatus(config(), N);
    expect(ready.state).toBe('ready');
    expect(ready.readyAt).toBeDefined();
    expect(ready.bootSeconds).toBeGreaterThanOrEqual(0);
    setBoot('down');
    expect((await getPoolInstanceStatus(config(), N)).state).toBe('hdc-lost');
    setBoot('true');
    expect((await getPoolInstanceStatus(config(), N)).state).toBe('ready');

    expect(await stopPoolInstance({ config: config(), instance: N })).toBe(true);
    const after = await getPoolInstanceStatus(config(), N);
    expect(after.state).toBe('stopped');
    expect(readPoolState(poolInstanceDir(config(), N))!.readyAt).toBeUndefined();

    const calls = lines('hdc.calls');
    expect(calls).toContain('tconn 127.0.0.1:55646');
    expect(calls).toContain('-t 127.0.0.1:55646 shell param get bootevent.boot.completed');
    expect(calls).toContain('tconn 127.0.0.1:55646 -remove');
    expect(calls.filter((c) => /^(start|kill)\b/.test(c))).toEqual([]);
  });

  it('reports stuck once the boot timeout passes without ready', async () => {
    await start(N, { bootTimeoutSeconds: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect((await getPoolInstanceStatus(config(), N)).state).toBe('stuck');
  });

  it('--wait-ready returns once the guest reports boot completed', async () => {
    setTimeout(() => setBoot('true'), 300);
    const st = await start(N, { waitReadySeconds: 20, pollIntervalMs: 100 });
    expect(st.state).toBe('ready');
  });

  it('runs two instances side by side and stops only the one asked', async () => {
    await start(N);
    await start(N + 1);
    setBoot('true');
    const all = await listPoolInstanceStatuses(config());
    expect(all.map((i) => [i.instance, i.state])).toEqual([[N, 'ready'], [N + 1, 'ready']]);
    await stopPoolInstance({ config: config(), instance: N });
    const after = await listPoolInstanceStatuses(config());
    expect(after.map((i) => [i.instance, i.state])).toEqual([[N, 'stopped'], [N + 1, 'ready']]);
  });

  it('does not launch a second QEMU for a running instance', async () => {
    const first = await start(N);
    const again = await start(N);
    expect(again.pid).toBe(first.pid);
    expect(lines('qemu.args')).toHaveLength(1);
    await expect(start(N, { fresh: true })).rejects.toThrow(/stop it before --fresh/);
  });

  it('reuses overlays across restarts, refuses them once a base image changed, and --fresh recreates them', async () => {
    await start(N);
    await stopPoolInstance({ config: config(), instance: N });
    await start(N);
    expect(lines('qemu-img.args')).toHaveLength(4);
    await stopPoolInstance({ config: config(), instance: N });

    fs.appendFileSync(path.join(emulatorDir, 'images', 'userdata.img'), 'written by instance 0\n');
    await expect(start(N)).rejects.toThrow(/userdata\.img .*changed.*--fresh/s);
    await start(N, { fresh: true });
    expect(lines('qemu-img.args')).toHaveLength(8);
  });

  it('fails clearly when one of the instance ports is taken', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(4444 + N, '127.0.0.1', () => r()));
    try {
      await expect(start(N)).rejects.toThrow(new RegExp(`serial ${4444 + N}`));
      expect(lines('qemu.args')).toEqual([]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('reports a QEMU that exits at once with its log tail and a lock hint', async () => {
    fs.writeFileSync(path.join(root, 'qemu.fail'), '');
    await expect(start(N)).rejects.toThrow(/exited with code 1[\s\S]*write" lock[\s\S]*Stop it first/);
    expect(readPoolState(poolInstanceDir(config(), N))!.pid).toBeUndefined();
  });

  it('names the missing images', async () => {
    fs.rmSync(path.join(emulatorDir, 'images', 'vendor.img'));
    await expect(start(N)).rejects.toThrow(/Missing emulator image\(s\).*vendor\.img/);
  });

  it('stop --discard deletes the overlays and state', async () => {
    await start(N);
    const dir = poolInstanceDir(config(), N);
    await stopPoolInstance({ config: config(), instance: N, discard: true });
    expect(fs.existsSync(dir)).toBe(false);
    expect(await listPoolInstanceStatuses(config())).toEqual([]);
  });

  it('the default emulator refuses to start while a pool instance runs', async () => {
    fs.writeFileSync(path.join(emulatorDir, 'images', 'run.sh'), '#!/bin/sh\nexit 0\n');
    await start(N);
    await expect(startEmulator({ config: config() })).rejects.toThrow(new RegExp(`emulator stop --instance ${N}`));
  });
});
