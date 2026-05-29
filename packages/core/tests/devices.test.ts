import { describe, expect, it } from 'vitest';
import { parseDeviceList } from '../src/hdc/devices.js';

describe('parseDeviceList', () => {
  it('returns [] for an empty target list', () => {
    expect(parseDeviceList('[Empty]\n')).toEqual([]);
    expect(parseDeviceList('')).toEqual([]);
    expect(parseDeviceList('\n  \n')).toEqual([]);
  });

  it('parses serial, connection, and status from a verbose listing', () => {
    const out = parseDeviceList(
      'emulator-5554\tUSB\tConnected\tlocalhost\n127.0.0.1:55555\tTCP\tOffline\tremote\n',
    );
    expect(out).toEqual([
      { serial: 'emulator-5554', status: 'Connected', connection: 'USB' },
      { serial: '127.0.0.1:55555', status: 'Offline', connection: 'TCP' },
    ]);
  });

  it('tolerates column reordering (status before connection)', () => {
    expect(parseDeviceList('dev1   Connected   USB')).toEqual([
      { serial: 'dev1', status: 'Connected', connection: 'USB' },
    ]);
  });

  it('defaults status to Unknown for a bare serial line', () => {
    expect(parseDeviceList('abc123def')).toEqual([{ serial: 'abc123def', status: 'Unknown' }]);
  });
});
