import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeCmdTools, getCmdToolsStatus, readCmdToolsInfo } from '../src/cmdTools/install.js';
import { requireHarmonyOsSdk } from '../src/harmonyos/sdk.js';
import { getHarmonyOsSdkListing } from '../src/sdk/list.js';
import { staticConfig } from '../src/ports/config.js';

/** version.txt as the HarmonyOS 6.1.1.280 command-line tools ship it. */
const VERSION_TXT = `# ======================
# Command Line Tools(linux-x64)
# Version: 6.1.1.280
# ======================

hvigor       : 6.24.2
codelinter   : 6.0.240
hstack       : 5.1.0
ohpm         : 6.1.2.268
releaseType  : release
HarmonyOS SDK: HarmonyOS 6.1.1 Release (include Ohos_sdk_public 6.1.1.125 (API Version 24 Release))
apiVersion   : 24
`;

const SDK_PKG = {
  meta: { version: '1.0.0' },
  data: {
    apiVersion: '24',
    displayName: 'HarmonyOS 6.1.1',
    path: 'HarmonyOS-6.1.1',
    platformVersion: '6.1.1',
    releaseType: 'Release',
    version: '6.1.1.125',
    stage: 'Release',
  },
};

describe('command-line tools status', () => {
  let tmp: string;
  let tools: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cmdtools-status-'));
    tools = path.join(tmp, 'command-line-tools');
    fs.mkdirSync(path.join(tools, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tools, 'bin', 'ohpm'), '');
    fs.writeFileSync(path.join(tools, 'version.txt'), VERSION_TXT);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const harmonyOsSdk = (): void => {
    fs.mkdirSync(path.join(tools, 'sdk', 'default', 'openharmony'), { recursive: true });
    fs.mkdirSync(path.join(tools, 'sdk', 'default', 'hms'), { recursive: true });
    fs.writeFileSync(path.join(tools, 'sdk', 'default', 'sdk-pkg.json'), JSON.stringify(SDK_PKG));
  };

  it('reports the release, the SDK the tools bundle and the tool versions (#21)', () => {
    harmonyOsSdk();
    const status = getCmdToolsStatus(staticConfig({ cmdToolsPath: tools }));
    expect(status).toMatchObject({
      installed: true,
      status: 'Installed (6.1.1.280)',
      version: '6.1.1.280',
      flavour: 'HarmonyOS',
      sdk: {
        path: path.join(tools, 'sdk'),
        displayName: 'HarmonyOS 6.1.1',
        platformVersion: '6.1.1',
        apiVersion: '24',
        build: '6.1.1.125',
      },
      tools: { hvigor: '6.24.2', codelinter: '6.0.240', hstack: '5.1.0', ohpm: '6.1.2.268' },
    });
    expect(describeCmdTools(status)).toBe('6.1.1.280 (HarmonyOS 6.1.1, API 24, hvigor 6.24.2)');
  });

  it('falls back to the API level in version.txt when the SDK has no sdk-pkg.json', () => {
    fs.mkdirSync(path.join(tools, 'sdk', 'default', 'openharmony'), { recursive: true });
    const info = readCmdToolsInfo(tools);
    expect(info).toMatchObject({ version: '6.1.1.280', flavour: 'OpenHarmony', sdk: { apiVersion: '24' } });
    expect(info.sdk?.displayName).toBeUndefined();
    expect(describeCmdTools(info)).toBe('6.1.1.280 (API 24, hvigor 6.24.2)');
  });

  it('leaves out what an install without version.txt or SDK does not say', () => {
    fs.rmSync(path.join(tools, 'version.txt'));
    const info = readCmdToolsInfo(tools);
    expect(info).toEqual({ flavour: 'OpenHarmony', tools: {} });
    expect(describeCmdTools(info)).toBe('unknown version');
  });

  it('is not installed without ohpm, and then carries no version fields', () => {
    fs.rmSync(path.join(tools, 'bin', 'ohpm'));
    const status = getCmdToolsStatus(staticConfig({ cmdToolsPath: tools }));
    expect(status.installed).toBe(false);
    expect(status.version).toBeUndefined();
    expect(status.sdk).toBeUndefined();
  });

  it('lists the HarmonyOS SDK the tools bundle, naming where it came from', () => {
    harmonyOsSdk();
    expect(getHarmonyOsSdkListing(staticConfig({ cmdToolsPath: tools }))).toEqual({
      flavour: 'HarmonyOS',
      installed: true,
      path: path.join(tools, 'sdk'),
      displayName: 'HarmonyOS 6.1.1',
      version: '6.1.1',
      api: '24',
      source: 'cmdtools',
    });
  });

  it('lists no HarmonyOS SDK for OpenHarmony tools, and the error names `cmdtools install`', () => {
    fs.mkdirSync(path.join(tools, 'sdk', 'default', 'openharmony'), { recursive: true });
    const config = staticConfig({ cmdToolsPath: tools });
    expect(getHarmonyOsSdkListing(config)).toBeNull();
    if (process.platform === 'linux') {
      expect(() => requireHarmonyOsSdk({ config })).toThrow(/oniro-app cmdtools install/);
    }
  });
});
