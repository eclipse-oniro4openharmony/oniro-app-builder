import { describe, expect, it } from 'vitest';
import { parseHilogLine } from '../src/hdc/hilog.js';

describe('parseHilogLine', () => {
  it('parses a typical error line', () => {
    const line = '05-19 22:35:37.818  3687  3712 E C01406/OHOS::RS: QueryEglBufferAge: eglQuerySurface is failed';
    expect(parseHilogLine(line)).toEqual({
      time: '05-19 22:35:37.818',
      pid: '3687',
      tid: '3712',
      level: 'E',
      tag: 'C01406/OHOS::RS',
      message: 'QueryEglBufferAge: eglQuerySurface is failed',
    });
  });

  it('parses each level letter', () => {
    const cases: Array<[string, 'D' | 'I' | 'W' | 'E' | 'F']> = [
      ['01-01 00:00:00.000  1  2 D Tag: msg', 'D'],
      ['01-01 00:00:00.000  1  2 I Tag: msg', 'I'],
      ['01-01 00:00:00.000  1  2 W Tag: msg', 'W'],
      ['01-01 00:00:00.000  1  2 E Tag: msg', 'E'],
      ['01-01 00:00:00.000  1  2 F Tag: msg', 'F'],
    ];
    for (const [line, level] of cases) {
      expect(parseHilogLine(line)?.level).toBe(level);
    }
  });

  it('preserves colons inside the message body', () => {
    const parsed = parseHilogLine('05-19 22:35:37.818  3687  3712 I Tag: key: value: nested');
    expect(parsed?.message).toBe('key: value: nested');
  });

  it('returns null for non-matching lines', () => {
    expect(parseHilogLine('')).toBeNull();
    expect(parseHilogLine('not a log line')).toBeNull();
    expect(parseHilogLine('05-19 22:35:37  3687  3712 E Tag: no millis')).toBeNull();
    expect(parseHilogLine('05-19 22:35:37.818  3687  3712 X Tag: bad level')).toBeNull();
  });
});
