import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findHvigorTooOld } from '../src/cmdTools/compat.js';
import { staticConfig } from '../src/ports/config.js';

describe('findHvigorTooOld', () => {
  let tmp: string;
  let tools: string;
  const config = () => staticConfig({ cmdToolsPath: tools });
  const hvigor = (version: string) =>
    fs.writeFileSync(path.join(tools, 'version.txt'), `# Version: 6.1.1.280\nhvigor       : ${version}\napiVersion   : 24\n`);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-compat-'));
    tools = path.join(tmp, 'command-line-tools');
    fs.mkdirSync(path.join(tools, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tools, 'bin', 'hvigorw'), '');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('names the hvigor an API 26 build needs, and where to get it', () => {
    hvigor('6.24.2');
    const tooOld = findHvigorTooOld(config(), 26);
    expect(tooOld).toMatchObject({ api: 26, hvigor: '6.24.2', toolsPath: tools });
    expect(tooOld!.message).toMatch(/^API 26 needs hvigor 6\.26\.0 or later, from the 26\.0\.0 or newer command-line tools; /);
    expect(tooOld!.message).toContain('hvigor 6.24.2');
    expect(tooOld!.fix).toMatch(/cmdtools install --from-zip <zip> --force.*ONIRO_CMD_TOOLS_PATH/);
  });

  it('passes hvigor 6.26 and later, projects before API 26, and tools of unknown version', () => {
    hvigor('6.26.4');
    expect(findHvigorTooOld(config(), 26)).toBeNull();
    hvigor('6.24.2');
    expect(findHvigorTooOld(config(), 23)).toBeNull();
    fs.rmSync(path.join(tools, 'version.txt'));
    expect(findHvigorTooOld(config(), 26)).toBeNull();
  });

  it('leaves a project that runs its own hvigorw wrapper alone, which pins its own hvigor', () => {
    hvigor('6.24.2');
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir);
    expect(findHvigorTooOld(config(), 26, projectDir)).not.toBeNull();
    // A working project-local wrapper: hvigorw plus the populated hvigor/ install it runs.
    fs.writeFileSync(path.join(projectDir, 'hvigorw'), '', { mode: 0o755 });
    fs.mkdirSync(path.join(projectDir, 'hvigor', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'hvigor', 'hvigor-wrapper.js'), '');
    expect(findHvigorTooOld(config(), 26, projectDir)).toBeNull();
  });
});
