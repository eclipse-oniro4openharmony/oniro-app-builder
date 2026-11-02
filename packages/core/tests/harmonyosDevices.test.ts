import { describe, expect, it, vi } from 'vitest';
import {
  collectLocalDevices,
  parseDeviceKind,
  parseUdid,
  registerDevices,
  type LocalDevice,
} from '../src/harmonyos/signing/devices.js';
import type { AgcClient, AgcDevice } from '../src/harmonyos/signing/agc.js';
import { SIGNING_ERRORS } from '../src/harmonyos/signing/errors.js';
import { staticConfig } from '../src/ports/config.js';
import { noopLogger } from '../src/ports/logger.js';

// No hdc in tests: whatever `targets` holds is attached.
const targets = vi.fn();
vi.mock('../src/hdc/devices.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listDevices: (...args: unknown[]) => targets(...args),
}));
const hdcExec = vi.fn();
vi.mock('../src/hdc/exec.js', () => ({ hdcExec: (...args: unknown[]) => hdcExec(...args) }));

const UDID = 'AB'.repeat(32);

/** An AGC whose team has `registered` devices; addDevice registers one more. */
function fakeAgc(registered: AgcDevice[]) {
  const devices = [...registered];
  const agc = {
    listDevices: vi.fn(async () => [...devices]),
    addDevice: vi.fn(async (udid: string) => {
      devices.push({ id: `id-${udid.slice(0, 4)}`, udid });
    }),
  };
  return agc as typeof agc & AgcClient;
}

const phone = (udid = UDID): LocalDevice => ({ serial: 'serial-1', udid, kind: 'phone' });

describe('collectLocalDevices', () => {
  /**
   * hdc answers `bm get -u` per serial from `udids`, and `getprop` with `kind`.
   * `unusable` lists more targets by status.
   */
  const attach = (udids: Record<string, string | Error>, kind = 'phone', unusable: Record<string, string> = {}) => {
    targets.mockResolvedValue([
      ...Object.keys(udids).map((serial) => ({ serial, status: 'Connected' })),
      ...Object.entries(unusable).map(([serial, status]) => ({ serial, status })),
    ]);
    hdcExec.mockImplementation(async ({ deviceSerial, args }: { deviceSerial: string; args: string[] }) => {
      if (!args.includes('bm')) return { stdout: kind };
      const answer = udids[deviceSerial]!;
      if (answer instanceof Error) throw answer;
      return { stdout: answer };
    });
  };
  const collect = (logger = noopLogger) => collectLocalDevices(staticConfig({}), logger);

  it('reads the UDID and kind of each connected device', async () => {
    attach({ 'serial-1': `udid of current device is\n${UDID.toLowerCase()}\n` }, 'wearable');
    await expect(collect()).resolves.toEqual({ devices: [{ serial: 'serial-1', udid: UDID, kind: 'wearable' }], skipped: [] });
  });

  it('reads a device whose status hdc did not report, as other device commands do', async () => {
    attach({ 'serial-1': UDID });
    targets.mockResolvedValue([{ serial: 'serial-1', status: 'Unknown' }]);
    await expect(collect()).resolves.toEqual({ devices: [{ serial: 'serial-1', udid: UDID, kind: 'phone' }], skipped: [] });
  });

  it('skips each attached device it cannot use, and says why', async () => {
    const warn = vi.fn();
    attach(
      { good: UDID, silent: 'error: failed to get udid', broken: new Error('hdc timed out') },
      'phone',
      { idle: 'Offline', locked: 'Unauthorized' },
    );
    await expect(collect({ ...noopLogger, warn })).resolves.toEqual({
      devices: [{ serial: 'good', udid: UDID, kind: 'phone' }],
      skipped: ['silent', 'broken', 'idle', 'locked'],
    });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[harmonyos] silent did not report a UDID (`bm get -u`), so it cannot be registered.',
      '[harmonyos] broken could not be read: hdc timed out',
      '[harmonyos] idle is offline; skipping it.',
      '[harmonyos] locked is unauthorized; accept the debugging prompt on the device to register it.',
    ]);
    const asked = hdcExec.mock.calls.map(([o]) => (o as { deviceSerial: string }).deviceSerial);
    expect(asked).not.toContain('idle');
    expect(asked).not.toContain('locked');
  });
});

describe('registerDevices', () => {
  it('registers a new connected device and names every team device', async () => {
    const agc = fakeAgc([{ id: 'd1', udid: 'CD'.repeat(32) }]);
    await expect(registerDevices(agc, [phone()], noopLogger)).resolves.toEqual(['d1', 'id-ABAB']);
    expect(agc.addDevice).toHaveBeenCalledWith(UDID, 'phone');
  });

  it('does not re-register a known device, whatever the case of its UDID', async () => {
    const agc = fakeAgc([{ id: 'd1', udid: UDID.toLowerCase() }]);
    await expect(registerDevices(agc, [phone()], noopLogger)).resolves.toEqual(['d1']);
    expect(agc.addDevice).not.toHaveBeenCalled();
    expect(agc.listDevices).toHaveBeenCalledTimes(1);
  });

  it("with nothing connected, names the team's registered devices", async () => {
    const agc = fakeAgc([
      { id: 'd1', udid: 'AA' },
      { id: 'd2', udid: 'BB' },
    ]);
    await expect(registerDevices(agc, [], noopLogger)).resolves.toEqual(['d1', 'd2']);
  });

  it('fails when there is no device anywhere', async () => {
    await expect(registerDevices(fakeAgc([]), [], noopLogger)).rejects.toThrow(SIGNING_ERRORS.DEVICE_NONE);
  });
});

describe('device parsing', () => {
  it('reads a 64-hex UDID in any wording, uppercased', () => {
    expect(parseUdid(`udid of current device is\n${'a'.repeat(64)}\n`)).toBe('A'.repeat(64));
    expect(parseUdid(`noise ${'abcdef0123456789'.repeat(4)} more`)).toBe('ABCDEF0123456789'.repeat(4));
    expect(parseUdid('')).toBe('');
    expect(parseUdid('udid of current device is\nnot-a-udid')).toBe('');
  });

  it('classifies device kinds, defaulting to phone', () => {
    expect(['liteWearable', 'wearable', 'tv', 'default', '', 'getprop: inaccessible'].map(parseDeviceKind)).toEqual([
      'liteWearable',
      'wearable',
      'tv',
      'phone',
      'phone',
      'phone',
    ]);
  });
});
