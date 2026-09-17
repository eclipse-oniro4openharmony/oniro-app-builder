import { describe, expect, it, vi } from 'vitest';
import { parseDeviceKind, parseUdid, registerDevices } from '../src/harmonyos/signing/devices.js';
import type { AgcClient, AgcDevice } from '../src/harmonyos/signing/agc.js';
import { SIGNING_ERRORS } from '../src/harmonyos/signing/errors.js';
import { staticConfig } from '../src/ports/config.js';
import { noopLogger } from '../src/ports/logger.js';

// No hdc in tests: one connected device, `serial-1`.
vi.mock('../src/hdc/devices.js', () => ({
  listDevices: vi.fn(async () => [{ serial: 'serial-1', status: 'Connected' }]),
}));
const UDID = 'AB'.repeat(32);
const hdcExec = vi.fn();
vi.mock('../src/hdc/exec.js', () => ({ hdcExec: (...args: unknown[]) => hdcExec(...args) }));

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

const register = (agc: AgcClient) => registerDevices(agc, staticConfig({}), noopLogger);

describe('registerDevices', () => {
  const connected = (udidOutput: string) =>
    hdcExec.mockImplementation(async ({ args }: { args: string[] }) => ({
      stdout: args.includes('bm') ? udidOutput : 'phone',
    }));

  it('registers a new connected device and names every team device', async () => {
    connected(`udid of current device is\n${UDID}\n`);
    const agc = fakeAgc([{ id: 'd1', udid: 'CD'.repeat(32) }]);
    await expect(register(agc)).resolves.toEqual({ deviceIds: ['d1', 'id-ABAB'], connectedUdids: [UDID] });
    expect(agc.addDevice).toHaveBeenCalledWith(UDID, 'phone');
  });

  it('does not re-register a known device', async () => {
    connected(UDID.toLowerCase());
    const agc = fakeAgc([{ id: 'd1', udid: UDID.toLowerCase() }]);
    await expect(register(agc)).resolves.toEqual({ deviceIds: ['d1'], connectedUdids: [UDID] });
    expect(agc.addDevice).not.toHaveBeenCalled();
  });

  it("with nothing connected, names the team's registered devices", async () => {
    connected('no udid here');
    const agc = fakeAgc([
      { id: 'd1', udid: 'AA' },
      { id: 'd2', udid: 'BB' },
    ]);
    await expect(register(agc)).resolves.toEqual({ deviceIds: ['d1', 'd2'], connectedUdids: [] });
  });

  it('fails when there is no device anywhere', async () => {
    connected('');
    await expect(register(fakeAgc([]))).rejects.toThrow(SIGNING_ERRORS.DEVICE_NONE);
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
