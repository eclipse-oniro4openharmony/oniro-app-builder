import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import { listTemplates } from '@oniroproject/core';
import { getBundledTemplateRoot } from '../src/lib/templateRoot.js';

// The ohosTest module of each bundled template must build on the SDK it targets.
// It once said `deviceTypes: ["phone"]` while the main module said "default"; the
// OpenHarmony SDK has no `phone` syscap set, so the test HAP failed at
// SyscapTransform with 00303060 and no scaffolded app could run its tests.
describe('bundled templates: ohosTest module', () => {
  const root = getBundledTemplateRoot();
  const templates = listTemplates(root);

  const readModule = (dir: string): { name: string; deviceTypes: string[] } =>
    (JSON5.parse(fs.readFileSync(path.join(dir, 'module.json5'), 'utf8')) as {
      module: { name: string; deviceTypes: string[] };
    }).module;

  it('finds the bundled templates', () => {
    expect(templates.map((t) => t.id)).toEqual(expect.arrayContaining(['EmptyAbility', 'NativeCpp', 'HarmonyOSApp']));
  });

  for (const template of templates) {
    const src = path.join(root, template.id, template.defaultModuleName, 'src');

    it(`${template.id}: declares the same deviceTypes as the main module`, () => {
      const main = readModule(path.join(src, 'main'));
      const test = readModule(path.join(src, 'ohosTest'));
      expect(test.deviceTypes).toEqual(main.deviceTypes);
      expect(test.name).toBe(`${main.name}_test`);
    });

    it(`${template.id}: runs every suite in its test directory`, () => {
      const testDir = path.join(src, 'ohosTest', 'ets', 'test');
      const suites = fs
        .readdirSync(testDir)
        .filter((f) => f.endsWith('.test.ets') && f !== 'List.test.ets')
        .map((f) => f.replace(/\.ets$/, ''));
      const list = fs.readFileSync(path.join(testDir, 'List.test.ets'), 'utf8');
      expect(suites.length).toBeGreaterThan(1);
      for (const suite of suites) expect(list).toContain(`from './${suite}'`);
    });

    it(`${template.id}: tests its own code, not only the placeholder assertion`, () => {
      const testDir = path.join(src, 'ohosTest', 'ets', 'test');
      const tests = fs.readdirSync(testDir).map((f) => fs.readFileSync(path.join(testDir, f), 'utf8'));
      const index = fs.readFileSync(path.join(src, 'main', 'ets', 'pages', 'Index.ets'), 'utf8');
      // A UI test that drives the page by the id the page sets, or a call into
      // the native library the template builds.
      const drivesIndex = tests.some((t) => /ON\.id\('HelloWorld'\)/.test(t)) && index.includes(".id('HelloWorld')");
      const callsNative = tests.some((t) => /from 'libentry\.so'/.test(t) && /testNapi\.add\(/.test(t));
      expect(drivesIndex || callsNative).toBe(true);
    });
  }
});
