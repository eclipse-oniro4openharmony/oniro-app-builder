import { describe, expect, it } from 'vitest';
import { detectAaStartFailure } from '../src/hdc/app.js';

describe('detectAaStartFailure', () => {
  it('flags the locked-screen refusal (aa start exits 0 but prints this)', () => {
    const out =
      'error: failed to start ability.\n' +
      'Error Code:10106102  Error Message:The device screen is locked during the application launch, unlock screen failed.';
    expect(detectAaStartFailure(out)).toMatch(/10106102/);
  });

  it('flags a bare error code / message', () => {
    expect(detectAaStartFailure('Error Code:401 Error Message:permission denied')).toBeTruthy();
  });

  it('flags a "failed to start ability" line on its own', () => {
    expect(detectAaStartFailure('error: failed to start ability.')).toBeTruthy();
  });

  it('returns null on a successful launch', () => {
    expect(detectAaStartFailure('start ability successfully.')).toBeNull();
  });

  it('returns null on empty output', () => {
    expect(detectAaStartFailure('')).toBeNull();
    expect(detectAaStartFailure('\n')).toBeNull();
  });
});
