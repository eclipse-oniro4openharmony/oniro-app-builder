import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSON5 from 'json5';
import { createScaffold, listTemplates, staticConfig } from '@oniroproject/core';
import { getBundledTemplateRoot } from '../src/lib/templateRoot.js';

// Exercises the *real* bundled NativeCpp template (not a synthetic fixture): it must be
// discoverable, carry the native C++ delta, and run through the same substitution engine
// as EmptyAbility. A scaffold-and-build smoke test runs in CI (test-sample-app.yml).
describe('NativeCpp template', () => {
  const root = getBundledTemplateRoot();
  let location: string;

  beforeEach(() => {
    location = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-nativecpp-'));
  });

  afterEach(() => {
    fs.rmSync(location, { recursive: true, force: true });
  });

  it('is discovered by listTemplates with the expected metadata', () => {
    const template = listTemplates(root).find((t) => t.id === 'NativeCpp');
    expect(template).toBeDefined();
    expect(template?.label).toBe('Native C++');
    expect(template?.defaultModuleName).toBe('entry');
  });

  it('scaffolds native sources, the native build wiring, and applies substitutions', async () => {
    const { projectDir } = await createScaffold({
      config: staticConfig(),
      templateId: 'NativeCpp',
      projectName: 'NativeDemo',
      bundleName: 'com.example.nativedemo',
      location,
      sdkApi: 23,
      templateRoot: root,
    });

    // Native C++ delta is present.
    expect(fs.existsSync(path.join(projectDir, 'entry/src/main/cpp/napi_init.cpp'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'entry/src/main/cpp/CMakeLists.txt'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'entry/src/main/cpp/types/libentry/Index.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'entry/src/mock/Libentry.mock.ets'))).toBe(true);

    // entry/build-profile.json5 enables the CMake-driven native build.
    const entryBuildProfile = JSON5.parse(
      fs.readFileSync(path.join(projectDir, 'entry/build-profile.json5'), 'utf8'),
    ) as { buildOption: { externalNativeOptions?: { path?: string } } };
    expect(entryBuildProfile.buildOption.externalNativeOptions?.path).toBe('./src/main/cpp/CMakeLists.txt');

    // The entry module depends on the native lib.
    const entryPkg = JSON5.parse(
      fs.readFileSync(path.join(projectDir, 'entry/oh-package.json5'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(entryPkg.dependencies?.['libentry.so']).toBe('file:./src/main/cpp/types/libentry');

    // Same substitution engine as EmptyAbility: bundle + numeric SDK.
    const appJson = JSON5.parse(
      fs.readFileSync(path.join(projectDir, 'AppScope/app.json5'), 'utf8'),
    ) as { app: { bundleName: string } };
    expect(appJson.app.bundleName).toBe('com.example.nativedemo');

    const buildProfile = JSON5.parse(
      fs.readFileSync(path.join(projectDir, 'build-profile.json5'), 'utf8'),
    ) as { app: { products: Array<{ compileSdkVersion: number; compatibleSdkVersion: number }> } };
    expect(buildProfile.app.products[0]!.compileSdkVersion).toBe(23);
    expect(buildProfile.app.products[0]!.compatibleSdkVersion).toBe(23);
  });
});
