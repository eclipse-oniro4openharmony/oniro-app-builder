import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { applyChanges } from '../src/install/apply.js';

const isWin = process.platform === 'win32';

// Fake hdc: `install -r <hap>` reports 9568332 for a hap whose name contains
// "signinfo"; otherwise installs succeed. pidof returns a fixed pid.
describe.skipIf(isWin)('applyChanges (fake hdc)', () => {
  let root: string;
  let projectDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-apply-'));
    const toolchains = path.join(root, 'sdk', 'default', 'openharmony', 'toolchains');
    fs.mkdirSync(toolchains, { recursive: true });
    const hdc = path.join(toolchains, 'hdc');
    fs.writeFileSync(
      hdc,
      `#!/bin/sh
case "$1" in
  install)
    if [ "$2" = "-r" ]; then
      case "$3" in
        *signinfo*) printf '[Fail]install failed: error 9568332 sign info inconsistent\\n'; exit 1 ;;
        *) printf 'install bundle successfully\\n'; exit 0 ;;
      esac
    else
      printf 'install bundle successfully\\n'; exit 0
    fi ;;
  uninstall) printf 'ok\\n'; exit 0 ;;
  shell)
    case "$2" in
      pidof*) printf '111\\n'; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
`,
    );
    fs.chmodSync(hdc, 0o755);
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-applyproj-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const config = () => staticConfig({ cmdToolsPath: root });

  it('refuses to reinstall a system bundle on sign-info mismatch (no uninstall)', async () => {
    const hap = path.join(projectDir, 'systemui-signinfo.hap');
    fs.writeFileSync(hap, 'fakehap');
    await expect(
      applyChanges({ config: config(), bundle: 'com.ohos.systemui', hapPath: hap, isSystemBundle: true }),
    ).rejects.toThrow(/9568332|system bundle|Align the signing/);
  });

  it('replaces a normal app and does not reboot when the pid is unchanged', async () => {
    const hap = path.join(projectDir, 'app-signed.hap');
    fs.writeFileSync(hap, 'fakehap');
    const result = await applyChanges({ config: config(), bundle: 'com.example.app', hapPath: hap, isSystemBundle: false });
    expect(result.method).toBe('replace');
    expect(result.replaced).toBe(true);
    expect(result.preInstallPid).toBe(111);
    expect(result.postInstallPid).toBe(111);
    expect(result.cacheCleared).toBe(false);
  });
});
