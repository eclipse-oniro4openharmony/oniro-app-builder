import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSON5 from 'json5';
import { createScaffold, detectRuntimeOs, listTemplates, staticConfig, type Logger } from '@oniroproject/core';
import { getBundledTemplateRoot } from '../src/lib/templateRoot.js';

// Exercises the real bundled HarmonyOSApp template. The thing that makes it a
// HarmonyOS project — runtimeOS plus the `"<version>(<api>)"` SDK shape — has to
// survive the same substitution engine the OpenHarmony templates run through.
describe('HarmonyOSApp template', () => {
  const root = getBundledTemplateRoot();
  let location: string;

  beforeEach(() => {
    location = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-harmonyos-'));
  });

  afterEach(() => {
    fs.rmSync(location, { recursive: true, force: true });
  });

  // Autodetection looks at an empty dir, so a HarmonyOS install on this machine cannot interfere.
  const scaffold = (overrides: { sdkApi?: number; installed?: string; logger?: Logger } = {}) =>
    createScaffold({
      config: staticConfig({
        cmdToolsPath: path.join(location, 'no-cmdtools'),
        ...(overrides.installed ? { harmonyosSdkPath: installSdk(overrides.installed) } : {}),
      }),
      templateId: 'HarmonyOSApp',
      projectName: 'HarmonyDemo',
      bundleName: 'com.example.harmonydemo',
      location,
      sdkApi: overrides.sdkApi ?? 17,
      templateRoot: root,
      logger: overrides.logger,
    });

  /** A HarmonyOS SDK whose sdk-pkg.json names `version`, e.g. `6.1.1(24)`. */
  const installSdk = (version: string) => {
    const [, platformVersion, apiVersion] = /^(.+)\((\d+)\)$/.exec(version)!;
    const sdkDir = path.join(location, 'hos-sdk');
    fs.mkdirSync(path.join(sdkDir, 'default', 'openharmony'), { recursive: true });
    fs.writeFileSync(
      path.join(sdkDir, 'default', 'sdk-pkg.json'),
      JSON.stringify({ data: { displayName: `HarmonyOS ${platformVersion}`, platformVersion, apiVersion } }),
    );
    return sdkDir;
  };

  const readProfile = (projectDir: string) =>
    JSON5.parse(fs.readFileSync(path.join(projectDir, 'build-profile.json5'), 'utf-8')) as {
      app: { products: Array<{ runtimeOS?: string; compileSdkVersion?: unknown; compatibleSdkVersion?: unknown }> };
    };

  it('is discovered by listTemplates with its own metadata', () => {
    const template = listTemplates(root).find((t) => t.id === 'HarmonyOSApp');
    expect(template).toBeDefined();
    expect(template?.label).toBe('HarmonyOS App');
    expect(template?.defaultModuleName).toBe('entry');
  });

  it('keeps runtimeOS HarmonyOS and writes the versioned SDK label', async () => {
    const { projectDir } = await scaffold({ sdkApi: 17 });
    const product = readProfile(projectDir).app.products[0]!;

    expect(product.runtimeOS).toBe('HarmonyOS');
    expect(product.compileSdkVersion).toBe('5.0.5(17)');
    expect(product.compatibleSdkVersion).toBe('5.0.5(17)');
  });

  it('derives the label from the requested API level', async () => {
    const { projectDir } = await scaffold({ sdkApi: 18 });
    expect(readProfile(projectDir).app.products[0]!.compatibleSdkVersion).toBe('5.1.0(18)');
  });

  it("takes the installed SDK's release for its API level, known to the table or not", async () => {
    const { projectDir } = await scaffold({ sdkApi: 99, installed: '9.9.9(99)' });
    expect(readProfile(projectDir).app.products[0]!.compileSdkVersion).toBe('9.9.9(99)');
  });

  it('warns when the requested release is not the installed one, which hvigor cannot build', async () => {
    const warnings: string[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} };
    const { projectDir } = await scaffold({ sdkApi: 18, installed: '6.1.1(24)', logger });
    expect(readProfile(projectDir).app.products[0]!.compileSdkVersion).toBe('5.1.0(18)');
    expect(warnings).toEqual([expect.stringMatching(/is 6\.1\.1\(24\), so a project declaring 5\.1\.0\(18\) will not build/)]);
  });

  it('fails before creating anything for an API level with no known HarmonyOS release', async () => {
    await expect(scaffold({ sdkApi: 99 })).rejects.toThrow(/No HarmonyOS release is known for API 99/);
    expect(fs.existsSync(path.join(location, 'HarmonyDemo'))).toBe(false);
  });

  it('produces a project detected as HarmonyOS', async () => {
    const { projectDir } = await scaffold();
    expect(detectRuntimeOs(projectDir)).toBe('HarmonyOS');
  });

  it('applies the usual name substitutions', async () => {
    const { projectDir } = await scaffold();
    const appJson = JSON5.parse(
      fs.readFileSync(path.join(projectDir, 'AppScope', 'app.json5'), 'utf-8'),
    ) as { app: { bundleName: string } };
    expect(appJson.app.bundleName).toBe('com.example.harmonydemo');
    expect(fs.existsSync(path.join(projectDir, 'entry', 'src', 'main', 'module.json5'))).toBe(true);
  });

  it('leaves the OpenHarmony template on the numeric SDK shape', async () => {
    const { projectDir } = await createScaffold({
      config: staticConfig(),
      templateId: 'EmptyAbility',
      projectName: 'OhosDemo',
      bundleName: 'com.example.ohosdemo',
      location,
      sdkApi: 20,
      templateRoot: root,
    });
    const product = readProfile(projectDir).app.products[0]!;
    expect(product.runtimeOS).toBe('OpenHarmony');
    expect(product.compileSdkVersion).toBe(20);
    expect(detectRuntimeOs(projectDir)).toBe('OpenHarmony');
  });
});
