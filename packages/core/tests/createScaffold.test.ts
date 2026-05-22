import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSON5 from 'json5';
import { createScaffold } from '../src/project/createScaffold.js';
import { staticConfig } from '../src/ports/config.js';
import { writeMinimalTemplate } from './_helpers/fixtureTemplate.js';

describe('createScaffold', () => {
  let workspace: string;
  let templateRoot: string;
  let location: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-scaffold-'));
    templateRoot = path.join(workspace, 'templates');
    location = path.join(workspace, 'projects');
    fs.mkdirSync(templateRoot, { recursive: true });
    fs.mkdirSync(location, { recursive: true });
    writeMinimalTemplate(templateRoot, 'EmptyAbility');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const baseArgs = () => ({
    config: staticConfig(),
    templateId: 'EmptyAbility',
    projectName: 'MyApp',
    bundleName: 'com.example.myapp',
    location,
    sdkApi: 23,
    templateRoot,
  });

  it('creates the project directory with the expected files', async () => {
    const { projectDir } = await createScaffold(baseArgs());
    expect(projectDir).toBe(path.join(location, 'MyApp'));
    expect(fs.existsSync(path.join(projectDir, 'build-profile.json5'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'AppScope', 'app.json5'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'entry', 'src', 'main', 'module.json5'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'entry', 'oh-package.json5'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'local.properties'))).toBe(true);
  });

  it('writes the chosen bundle name into AppScope/app.json5', async () => {
    const { projectDir } = await createScaffold(baseArgs());
    const appJson = JSON5.parse(fs.readFileSync(path.join(projectDir, 'AppScope', 'app.json5'), 'utf8')) as {
      app: { bundleName: string };
    };
    expect(appJson.app.bundleName).toBe('com.example.myapp');
  });

  it('writes the chosen SDK api into build-profile.json5', async () => {
    const { projectDir } = await createScaffold(baseArgs());
    const buildProfile = JSON5.parse(
      fs.readFileSync(path.join(projectDir, 'build-profile.json5'), 'utf8'),
    ) as { app: { products: Array<{ compileSdkVersion: number; compatibleSdkVersion: number }> } };
    expect(buildProfile.app.products[0]!.compileSdkVersion).toBe(23);
    expect(buildProfile.app.products[0]!.compatibleSdkVersion).toBe(23);
  });

  it('writes the project name into the app_name string resource', async () => {
    const { projectDir } = await createScaffold(baseArgs());
    const strings = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, 'AppScope', 'resources', 'base', 'element', 'string.json'),
        'utf8',
      ),
    ) as { string: Array<{ name: string; value: string }> };
    const appName = strings.string.find((s) => s.name === 'app_name');
    expect(appName?.value).toBe('MyApp');
  });

  it('renames the default module folder when --module is set', async () => {
    const { projectDir } = await createScaffold({ ...baseArgs(), moduleName: 'core' });
    expect(fs.existsSync(path.join(projectDir, 'core'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'entry'))).toBe(false);
    const moduleJson = JSON5.parse(
      fs.readFileSync(path.join(projectDir, 'core', 'src', 'main', 'module.json5'), 'utf8'),
    ) as { module: { name: string } };
    expect(moduleJson.module.name).toBe('core');
  });

  it('writes .vscode/settings.json with the right hapPath for the chosen module', async () => {
    const { projectDir } = await createScaffold({ ...baseArgs(), moduleName: 'core' });
    const settings = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.vscode', 'settings.json'), 'utf8'),
    ) as { 'oniro.hapPath': string };
    expect(settings['oniro.hapPath']).toBe('core/build/default/outputs/default/core-default-signed.hap');
  });

  it('drops template.json from the scaffolded project', async () => {
    const { projectDir } = await createScaffold(baseArgs());
    expect(fs.existsSync(path.join(projectDir, 'template.json'))).toBe(false);
  });

  it('does NOT carry the placeholder bundle name from the template', async () => {
    const { projectDir } = await createScaffold(baseArgs());
    const appJson = JSON5.parse(fs.readFileSync(path.join(projectDir, 'AppScope', 'app.json5'), 'utf8')) as {
      app: { bundleName: string };
    };
    expect(appJson.app.bundleName).not.toBe('com.template.placeholder');
  });

  it('refuses to overwrite an existing project by default', async () => {
    await createScaffold(baseArgs());
    await expect(createScaffold(baseArgs())).rejects.toThrow(/already exists/);
  });

  it('replaces an existing project when overwrite: true', async () => {
    await createScaffold(baseArgs());
    fs.writeFileSync(path.join(location, 'MyApp', 'marker.txt'), 'sentinel');
    await createScaffold({ ...baseArgs(), overwrite: true });
    expect(fs.existsSync(path.join(location, 'MyApp', 'marker.txt'))).toBe(false);
    expect(fs.existsSync(path.join(location, 'MyApp', 'build-profile.json5'))).toBe(true);
  });

  it('rejects invalid project names', async () => {
    await expect(createScaffold({ ...baseArgs(), projectName: 'bad/name' })).rejects.toThrow(/Invalid project name/);
  });

  it('rejects invalid bundle names', async () => {
    await expect(createScaffold({ ...baseArgs(), bundleName: 'not-reverse-dns' })).rejects.toThrow(/Invalid bundle name/);
  });

  it('rejects unknown template ids', async () => {
    await expect(createScaffold({ ...baseArgs(), templateId: 'NotATemplate' })).rejects.toThrow(/Template not found/);
  });

  it('rejects nonexistent locations', async () => {
    await expect(createScaffold({ ...baseArgs(), location: path.join(workspace, 'does-not-exist') })).rejects.toThrow(
      /Location does not exist/,
    );
  });

  it('normalizes .json5 files to strict-JSON formatting', async () => {
    const { projectDir } = await createScaffold(baseArgs());
    const raw = fs.readFileSync(path.join(projectDir, 'build-profile.json5'), 'utf8');
    // Strict JSON: keys are quoted, no trailing commas, no comments.
    expect(raw).toMatch(/^\{[\s\S]*\}\s*$/);
    expect(raw).toMatch(/"app":/);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
