import { describe, expect, it, afterEach } from 'vitest';
import { CommandFailedError } from '../src/ports/errors.js';
import {
  ensureOk,
  hdcClientFailure,
  hdcTargetArgs,
  hdcTargetArgsFor,
  resolveDeviceSerial,
} from '../src/hdc/exec.js';
import { parseParamValues } from '../src/hdc/param.js';

describe('resolveDeviceSerial', () => {
  it('prefers an explicit serial, then ONIRO_DEVICE_SERIAL, then DEVICE_SERIAL', () => {
    const env = { ONIRO_DEVICE_SERIAL: 'oniro', DEVICE_SERIAL: 'plain' };
    expect(resolveDeviceSerial('explicit', env)).toBe('explicit');
    expect(resolveDeviceSerial(undefined, env)).toBe('oniro');
    expect(resolveDeviceSerial(undefined, { DEVICE_SERIAL: 'plain' })).toBe('plain');
    expect(resolveDeviceSerial(undefined, {})).toBeUndefined();
  });

  it('treats auto as "let hdc choose"', () => {
    expect(resolveDeviceSerial('auto', { ONIRO_DEVICE_SERIAL: 'oniro' })).toBe('oniro');
    expect(resolveDeviceSerial(undefined, { ONIRO_DEVICE_SERIAL: 'auto' })).toBeUndefined();
  });
});

describe('hdcTargetArgsFor', () => {
  afterEach(() => {
    delete process.env.ONIRO_DEVICE_SERIAL;
  });

  it('addresses device commands at ONIRO_DEVICE_SERIAL, including a TCP serial', () => {
    process.env.ONIRO_DEVICE_SERIAL = '127.0.0.1:5555';
    expect(hdcTargetArgs()).toEqual(['-t', '127.0.0.1:5555']);
    expect(hdcTargetArgsFor(['shell', 'ls'])).toEqual(['-t', '127.0.0.1:5555']);
    expect(hdcTargetArgsFor(['install', '-r', 'a.hap'])).toEqual(['-t', '127.0.0.1:5555']);
  });

  it('leaves hdc server commands unaddressed unless a serial is explicit', () => {
    process.env.ONIRO_DEVICE_SERIAL = 'GS6CTU300263';
    expect(hdcTargetArgsFor(['list', 'targets', '-v'])).toEqual([]);
    expect(hdcTargetArgsFor(['tconn', '127.0.0.1:5555'])).toEqual([]);
    expect(hdcTargetArgsFor(['start', '-r'])).toEqual([]);
    expect(hdcTargetArgsFor(['list', 'targets'], 'X')).toEqual(['-t', 'X']);
  });

  it('adds nothing when no device is named anywhere', () => {
    expect(hdcTargetArgsFor(['shell', 'ls'])).toEqual([]);
  });
});

describe('hdcClientFailure', () => {
  it('spots the [Fail] line hdc prints while exiting 0', () => {
    expect(hdcClientFailure('[Fail]ExecuteCommand need connect-key? please confirm a device by help info\n')).toBe(
      '[Fail]ExecuteCommand need connect-key? please confirm a device by help info',
    );
    expect(hdcClientFailure('\n[Fail]Not match target founded, check connect-key please\n')).toMatch(/Not match target/);
  });

  it('ignores normal output and a marker further down', () => {
    expect(hdcClientFailure('hi\n')).toBeNull();
    expect(hdcClientFailure('[Info]Target is connected, repeat operation\n')).toBeNull();
    expect(hdcClientFailure('line one\n[Fail] printed by the device\n')).toBeNull();
  });
});

describe('ensureOk', () => {
  it('reports stdout when stderr is empty, and says how to pick a device', () => {
    const res = { code: 1, stdout: '[Fail]ExecuteCommand need connect-key? please confirm a device by help info', stderr: '' };
    expect(() => ensureOk(res, 'hdc shell ls')).toThrow(CommandFailedError);
    expect(() => ensureOk(res, 'hdc shell ls')).toThrow(/ONIRO_DEVICE_SERIAL/);
  });
});

describe('parseParamValues', () => {
  it('splits one round trip into values, leaving unset properties undefined', () => {
    const stdout =
      'Get parameter "const.product.os.dist.name" fail! errNum is:106!\n__ONIRO_PARAM__\n' +
      '26 \n__ONIRO_PARAM__\n' +
      'arm64-v8a \n__ONIRO_PARAM__\n';
    expect(parseParamValues(['const.product.os.dist.name', 'const.ohos.apiversion', 'const.product.cpu.abilist'], stdout)).toEqual({
      'const.product.os.dist.name': undefined,
      'const.ohos.apiversion': '26',
      'const.product.cpu.abilist': 'arm64-v8a',
    });
  });
});
