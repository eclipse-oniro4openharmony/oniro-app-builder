import { describe, expect, it } from 'vitest';
import { buildInputCommand, buildGestureCommands, buildRawTouchCommand } from '../src/hdc/input.js';
import { OniroError } from '../src/ports/errors.js';

describe('buildInputCommand', () => {
  it('builds click/doubleClick/longClick with px coords', () => {
    expect(buildInputCommand({ config: {} as never, type: 'click', pxX: 100, pxY: 200 })).toBe('uitest uiInput click 100 200');
    expect(buildInputCommand({ config: {} as never, type: 'doubleClick', pxX: 1, pxY: 2 })).toBe('uitest uiInput doubleClick 1 2');
    expect(buildInputCommand({ config: {} as never, type: 'longClick', pxX: 3, pxY: 4 })).toBe('uitest uiInput longClick 3 4');
  });

  it('builds swipe/drag/fling, with optional speed', () => {
    expect(buildInputCommand({ config: {} as never, type: 'swipe', pxX: 10, pxY: 20, pxX2: 30, pxY2: 40, speed: 600 })).toBe(
      'uitest uiInput swipe 10 20 30 40 600',
    );
    expect(buildInputCommand({ config: {} as never, type: 'drag', pxX: 10, pxY: 20, pxX2: 30, pxY2: 40 })).toBe(
      'uitest uiInput drag 10 20 30 40',
    );
  });

  it('builds keyEvent and inputText (with and without coords), escaping quotes', () => {
    expect(buildInputCommand({ config: {} as never, type: 'keyEvent', key: 'Back' })).toBe('uitest uiInput keyEvent Back');
    expect(buildInputCommand({ config: {} as never, type: 'inputText', text: 'hello' })).toBe("uitest uiInput text 'hello'");
    expect(buildInputCommand({ config: {} as never, type: 'inputText', pxX: 5, pxY: 6, text: 'hi' })).toBe(
      "uitest uiInput inputText 5 6 'hi'",
    );
    expect(buildInputCommand({ config: {} as never, type: 'inputText', text: "it's" })).toBe("uitest uiInput text 'it'\\''s'");
  });

  it('throws when required fields are missing', () => {
    expect(() => buildInputCommand({ config: {} as never, type: 'click', pxX: 1 })).toThrow(OniroError);
    expect(() => buildInputCommand({ config: {} as never, type: 'swipe', pxX: 1, pxY: 2, pxX2: 3 })).toThrow(/pxY2/);
    expect(() => buildInputCommand({ config: {} as never, type: 'keyEvent' })).toThrow(/requires a key/);
  });
});

describe('buildGestureCommands', () => {
  it('emits a drag per segment with derived speed', () => {
    const cmds = buildGestureCommands([
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 100, t: 100 },
      { x: 50, y: 100, t: 100 },
    ]);
    // segment 1: dist 100 over 100ms → 1000 px/s; segment 2: dt 0 → no speed
    expect(cmds).toEqual(['uitest uiInput drag 0 0 0 100 1000', 'uitest uiInput drag 0 100 50 100']);
  });

  it('throws for fewer than two waypoints', () => {
    expect(() => buildGestureCommands([{ x: 0, y: 0, t: 0 }])).toThrow(/two waypoints/);
  });
});

describe('buildRawTouchCommand', () => {
  it('builds a uinput -T sequence with -i intervals from time deltas', () => {
    expect(
      buildRawTouchCommand([
        { type: 'down', x: 10, y: 20, t: 0 },
        { type: 'move', x: 10, y: 80, t: 50 },
        { type: 'up', x: 10, y: 80, t: 100 },
      ]),
    ).toBe('uinput -T -d 10 20 -i 50 -m 10 20 10 80 -i 50 -u 10 80');
  });

  it('throws for an empty event list', () => {
    expect(() => buildRawTouchCommand([])).toThrow(OniroError);
  });
});
