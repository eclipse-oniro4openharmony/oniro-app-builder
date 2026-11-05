import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { formatInstanceRow, registerEmulatorCommand } from '../src/commands/emulator.js';

function subcommand(name: string): Command {
  const program = new Command();
  registerEmulatorCommand(program);
  const sub = program.commands.find((c) => c.name() === 'emulator')?.commands.find((c) => c.name() === name);
  if (!sub) throw new Error(`no 'emulator ${name}' command registered`);
  return sub;
}

describe('emulator pool options', () => {
  it('start, status and stop take --instance; start has the pool flags', () => {
    const start = subcommand('start').helpInformation();
    for (const flag of ['--instance <n>', '--memory <size>', '--smp <n>', '--fresh', '--wait-ready <seconds>', '--boot-timeout <seconds>', '--accel <kind>']) {
      expect(start).toContain(flag);
    }
    expect(subcommand('status').helpInformation()).toContain('--instance <n>');
    const stop = subcommand('stop').helpInformation();
    expect(stop).toContain('--instance <n>');
    expect(stop).toContain('--discard');
  });

  it('rejects an instance number out of range or not a number', async () => {
    for (const bad of ['100', '-1', 'two', '1.5']) {
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registerEmulatorCommand(program); // subcommands inherit exitOverride and the output config
      await expect(program.parseAsync(['node', 'oniro-app', 'emulator', 'stop', '--instance', bad])).rejects.toThrow(/0 to 99/);
    }
  });
});

describe('formatInstanceRow', () => {
  it('lists the health, ports and process facts of a pool instance', () => {
    expect(
      formatInstanceRow({
        instance: 2,
        state: 'ready',
        address: '127.0.0.1:55557',
        hdcPort: 55557,
        vncPort: 5902,
        serialPort: 4446,
        pid: 1234,
        smp: 2,
        memory: '2048M',
        bootSeconds: 14,
        hdcReachable: true,
        bootCompleted: true,
      }),
    ).toBe('2\tready\thdc=127.0.0.1:55557\tvnc=127.0.0.1:5902\tserial=127.0.0.1:4446\tpid=1234\tcpus=2\tmem=2048M\tboot=14s');
  });

  it('keeps the default emulator to its hdc address', () => {
    expect(
      formatInstanceRow({ instance: 0, state: 'stopped', address: '127.0.0.1:55555', hdcPort: 55555, hdcReachable: false, bootCompleted: false }),
    ).toBe('0\tstopped\thdc=127.0.0.1:55555');
  });
});
