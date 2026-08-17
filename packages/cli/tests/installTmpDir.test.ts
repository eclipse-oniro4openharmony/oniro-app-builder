import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerSdkCommand } from '../src/commands/sdk.js';
import { registerCmdToolsCommand } from '../src/commands/cmdtools.js';
import { registerEmulatorCommand } from '../src/commands/emulator.js';
import { createEnvConfig } from '../src/adapters/config.js';

/** Help text of `<group> install`, e.g. `cmdtools install`. */
function installHelp(register: (program: Command) => void, group: string): string {
  const program = new Command();
  register(program);
  const sub = program.commands
    .find((c) => c.name() === group)
    ?.commands.find((c) => c.name() === 'install');
  if (!sub) throw new Error(`no '${group} install' command registered`);
  return sub.helpInformation();
}

describe('--tmp-dir on the downloading install commands', () => {
  for (const [group, register] of [
    ['sdk', registerSdkCommand],
    ['cmdtools', registerCmdToolsCommand],
    ['emulator', registerEmulatorCommand],
  ] as const) {
    it(`${group} install documents --tmp-dir and ONIRO_TMP_DIR`, () => {
      const help = installHelp(register, group);
      expect(help).toContain('--tmp-dir <path>');
      expect(help).toContain('ONIRO_TMP_DIR');
    });
  }
});

describe('ONIRO_TMP_DIR', () => {
  it('maps to the tmpDir config key', () => {
    expect(createEnvConfig({ ONIRO_TMP_DIR: '/mnt/big/scratch' }).get('tmpDir', '')).toBe('/mnt/big/scratch');
  });

  it('falls back to the empty default when unset', () => {
    expect(createEnvConfig({}).get('tmpDir', '')).toBe('');
  });

  it('expands ${userHome}', () => {
    const cfg = createEnvConfig({ ONIRO_TMP_DIR: '${userHome}/.cache/oniro-tmp' });
    expect(cfg.get('tmpDir', '')).toMatch(/\.cache\/oniro-tmp$/);
  });
});
