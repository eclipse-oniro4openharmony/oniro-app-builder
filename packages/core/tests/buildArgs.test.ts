import { describe, expect, it } from 'vitest';
import { buildHvigorwArgs } from '../src/build/runHvigorw.js';
import { parseCodelinterFindings } from '../src/build/codelinter.js';

describe('buildHvigorwArgs', () => {
  it('is parallel by default (no --no-parallel)', () => {
    const args = buildHvigorwArgs({});
    expect(args).not.toContain('--no-parallel');
    expect(args).toEqual(['assembleHap', '--mode', 'module', '-p', 'product=default', '--stacktrace', '--no-daemon']);
  });

  it('adds --no-parallel only when parallel:false', () => {
    expect(buildHvigorwArgs({ parallel: false })).toContain('--no-parallel');
    expect(buildHvigorwArgs({ parallel: true })).not.toContain('--no-parallel');
  });

  it('forwards task/product/module/buildMode/extraArgs', () => {
    expect(
      buildHvigorwArgs({ task: 'assembleApp', product: 'phone', module: 'phone_x', buildMode: 'release', extraArgs: ['--foo'] }),
    ).toEqual([
      'assembleApp', '--mode', 'module',
      '-p', 'product=phone', '-p', 'module=phone_x', '-p', 'buildMode=release',
      '--stacktrace', '--no-daemon', '--foo',
    ]);
  });
});

describe('parseCodelinterFindings', () => {
  it('parses file:line[:col]: severity: message [code] lines', () => {
    const out =
      'entry/src/main/ets/Foo.ets:12:5: error: Unexpected var [@typescript-eslint/no-var]\n' +
      'entry/src/main/ets/Bar.ets:3: warning: Missing semicolon\n' +
      'random noise that is not a finding\n';
    expect(parseCodelinterFindings(out)).toEqual([
      { file: 'entry/src/main/ets/Foo.ets', line: 12, severity: 'error', code: '@typescript-eslint/no-var', message: 'Unexpected var' },
      { file: 'entry/src/main/ets/Bar.ets', line: 3, severity: 'warning', code: '', message: 'Missing semicolon' },
    ]);
  });

  it('returns [] when nothing matches', () => {
    expect(parseCodelinterFindings('all good\n\n')).toEqual([]);
  });
});
