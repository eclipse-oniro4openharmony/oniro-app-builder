import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  installApp: vi.fn(),
}));

vi.mock('@oniroproject/core', async () => {
  const actual = await vi.importActual<typeof import('@oniroproject/core')>('@oniroproject/core');
  return { ...actual, installApp: mocks.installApp };
});

import { noopLogger, noopProgress, staticConfig } from '@oniroproject/core';
import { registerAppCommand } from '../src/commands/app.js';
import { setRuntime } from '../src/lib/runtime.js';

describe('app install', () => {
  beforeEach(() => {
    mocks.installApp.mockReset();
    mocks.installApp.mockResolvedValue({ installed: true, bundleName: '', hapPath: '', output: '' });
    setRuntime({ config: staticConfig(), logger: noopLogger, progress: noopProgress });
  });

  afterEach(() => {
    setRuntime(null);
  });

  it('forwards --device to installApp', async () => {
    const program = new Command();
    registerAppCommand(program);

    await program.parseAsync(
      ['app', 'install', 'project', '--hap', 'app.hap', '--device', 'ABC123'],
      { from: 'user' },
    );

    expect(mocks.installApp).toHaveBeenCalledWith({
      config: expect.any(Object),
      projectDir: path.resolve('project'),
      hapPath: 'app.hap',
      deviceSerial: 'ABC123',
      logger: noopLogger,
    });
  });
});
