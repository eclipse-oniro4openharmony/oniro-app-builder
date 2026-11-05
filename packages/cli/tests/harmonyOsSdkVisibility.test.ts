import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { formatHarmonyOsSdkNote } from '../src/commands/sdk.js';
import { formatCmdToolsSdk, registerCmdToolsCommand } from '../src/commands/cmdtools.js';

describe('the HarmonyOS SDK in `sdk list` and `cmdtools` (#21)', () => {
  it('sdk list points at cmdtools and lists the HarmonyOS SDK it finds', () => {
    const text = formatHarmonyOsSdkNote({
      flavour: 'HarmonyOS',
      installed: true,
      path: '/home/u/command-line-tools/sdk',
      displayName: 'HarmonyOS 6.1.1',
      version: '6.1.1',
      api: '24',
      source: 'cmdtools',
    });
    expect(text).toContain('`oniro-app cmdtools`');
    expect(text).toMatch(/^\*  HarmonyOS 6\.1\.1 +api 24  \/home\/u\/command-line-tools\/sdk, from the command-line tools$/m);
  });

  it('sdk list names the install command when there is no HarmonyOS SDK', () => {
    expect(formatHarmonyOsSdkNote(null)).toContain('`oniro-app cmdtools install` installs one');
  });

  it('cmdtools says it supplies the HarmonyOS SDK', () => {
    const program = new Command();
    registerCmdToolsCommand(program);
    expect(program.commands.find((c) => c.name() === 'cmdtools')?.description()).toContain('HarmonyOS SDK');
  });

  it('formats the bundled SDK for cmdtools status', () => {
    expect(
      formatCmdToolsSdk({ path: '/t/sdk', displayName: 'HarmonyOS 6.1.1', apiVersion: '24', build: '6.1.1.125' }),
    ).toBe('HarmonyOS 6.1.1, API 24 (6.1.1.125) at /t/sdk');
    expect(formatCmdToolsSdk({ path: '/t/sdk' })).toBe('SDK at /t/sdk');
  });
});
