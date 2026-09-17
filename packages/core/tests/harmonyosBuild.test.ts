import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildHap } from '../src/build/buildHap.js';
import { runHvigorw } from '../src/build/runHvigorw.js';
import { staticConfig } from '../src/ports/config.js';
import { CmdToolsNotInstalledError } from '../src/ports/errors.js';

// The tools are shell-script stand-ins that log how they were invoked.
describe.skipIf(process.platform === 'win32')('building a HarmonyOS project', () => {
  let tmp: string;
  let projectDir: string;
  let log: string;

  /** An executable at `file` that appends `<name> <args> DEVECO_SDK_HOME=… OHOS_BASE_SDK_HOME=…` to the log. */
  const tool = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `#!/bin/sh\necho "${file} $* DEVECO_SDK_HOME=$DEVECO_SDK_HOME OHOS_BASE_SDK_HOME=$OHOS_BASE_SDK_HOME" >> "${log}"\n`,
      { mode: 0o755 },
    );
    return file;
  };
  /** Matches a logged invocation of `file` whose line contains `...parts` in order. */
  const invoked = (file: string, ...parts: string[]) =>
    expect.stringMatching(new RegExp(`^${[file, ...parts].map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}`));
  const invocations = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

  /** A HarmonyOS command-line-tools install at `root`, with `bin/ohpm` and `bin/hvigorw`. */
  const install = (root = path.join(tmp, 'hos-tools')) => {
    fs.mkdirSync(path.join(root, 'sdk', 'default', 'openharmony'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'sdk', 'default', 'sdk-pkg.json'),
      JSON.stringify({ data: { displayName: 'HarmonyOS 6.1.1', platformVersion: '6.1.1', apiVersion: '24' } }),
    );
    tool(path.join(root, 'bin', 'ohpm'));
    tool(path.join(root, 'bin', 'hvigorw'));
    return root;
  };

  const project = (runtimeOS: string) => {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', runtimeOS }] }, modules: [] }),
    );
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-hos-build-'));
    projectDir = path.join(tmp, 'project');
    log = path.join(tmp, 'invocations.log');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("installs dependencies and builds with the HarmonyOS install's own tools and SDK", async () => {
    project('HarmonyOS');
    const root = install();
    // No OpenHarmony command-line tools on this machine at all.
    const config = staticConfig({ harmonyosSdkPath: root, cmdToolsPath: path.join(tmp, 'absent') });

    const result = await buildHap({ config, projectDir });

    expect(result.exitCode).toBe(0);
    expect(invocations()).toEqual([
      invoked(`${root}/bin/ohpm`, ' install --all '),
      invoked(`${root}/bin/hvigorw`, ' assembleHap ', ` DEVECO_SDK_HOME=${root}/sdk `),
    ]);
    expect(result.warnings).toEqual([expect.stringContaining('oniro-app sign --harmonyos')]);
  });

  it("prefers the project's own complete hvigorw", async () => {
    project('HarmonyOS');
    const root = install();
    const local = tool(path.join(projectDir, 'hvigorw'));
    fs.mkdirSync(path.join(projectDir, 'hvigor', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'hvigor', 'hvigor-wrapper.js'), '');

    await runHvigorw({ config: staticConfig({ harmonyosSdkPath: root }), projectDir });

    expect(invocations()).toEqual([invoked(local, ` DEVECO_SDK_HOME=${root}/sdk `)]);
  });

  it('needs a HarmonyOS SDK, not the OpenHarmony command-line tools', async () => {
    project('HarmonyOS');
    const config = staticConfig({ harmonyosSdkPath: path.join(tmp, 'absent'), cmdToolsPath: path.join(tmp, 'absent') });
    expect(() => runHvigorw({ config, projectDir })).toThrow(/No HarmonyOS SDK found/);
  });

  it('leaves OpenHarmony projects on the command-line tools', async () => {
    project('OpenHarmony');
    const root = install();
    expect(() =>
      runHvigorw({ config: staticConfig({ harmonyosSdkPath: root, cmdToolsPath: path.join(tmp, 'absent') }), projectDir }),
    ).toThrow(CmdToolsNotInstalledError);

    const cmdTools = path.join(tmp, 'oh-tools');
    const hvigorw = tool(path.join(cmdTools, 'bin', 'hvigorw'));
    const sdkRootDir = path.join(tmp, 'oh-sdk');
    await runHvigorw({ config: staticConfig({ harmonyosSdkPath: root, cmdToolsPath: cmdTools, sdkRootDir }), projectDir });
    expect(invocations()).toEqual([invoked(hvigorw, ` OHOS_BASE_SDK_HOME=${sdkRootDir}${path.sep}`)]);
  });
});
