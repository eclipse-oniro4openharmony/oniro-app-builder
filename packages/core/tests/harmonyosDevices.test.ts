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
vi.mock('../src/hdc/devices.js', () => ({ listDevices: (...args: unknown[]) => targets(...args) }));
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
  /** hdc answers `bm get -u` per serial from `udids`, and `getprop` with `kind`. */
  const attach = (udids: Record<string, string | Error>, kind = 'phone', offline: string[] = []) => {
    targets.mockResolvedValue([
      ...Object.keys(udids).map((serial) => ({ serial, status: 'Connected' })),
      ...offline.map((serial) => ({ serial, status: 'Offline' })),
    ]);
    hdcExec.mockImplementation(async ({ deviceSerial, args }: { deviceSerial: string; args: string[] }) => {
      if (!args.includes('bm')) return { stdout: kind };
      const answer = udids[deviceSerial]!;
      if (answer instanceof Error) throw answer;
      return { stdout: answer };
    });
  };
  const collect = () => collectLocalDevices(staticConfig({}), noopLogger);

  it('reads the UDID and kind of each connected device', async () => {
    attach({ 'serial-1': `udid of current device is\n${UDID.toLowerCase()}\n` }, 'wearable');
    await expect(collect()).resolves.toEqual([{ serial: 'serial-1', udid: UDID, kind: 'wearable' }]);
  });

  it('skips offline devices, devices without a UDID, and devices that fail to answer', async () => {
    attach({ good: UDID, silent: 'no udid here', broken: new Error('hdc timed out') }, 'phone', ['offline']);
    await expect(collect()).resolves.toEqual([{ serial: 'good', udid: UDID, kind: 'phone' }]);
    expect(hdcExec.mock.calls.some(([o]) => (o as { deviceSerial: string }).deviceSerial === 'offline')).toBe(false);
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
