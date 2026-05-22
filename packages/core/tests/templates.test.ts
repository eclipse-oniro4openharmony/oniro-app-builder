import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listTemplates, validateTemplateLayout } from '../src/project/templates.js';
import { writeMinimalTemplate } from './_helpers/fixtureTemplate.js';

describe('listTemplates', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-templates-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns empty array when the template root does not exist', () => {
    expect(listTemplates(path.join(root, 'nope'))).toEqual([]);
  });

  it('discovers templates via direct subfolders', () => {
    writeMinimalTemplate(root, 'EmptyAbility');
    writeMinimalTemplate(root, 'CustomTemplate');
    const templates = listTemplates(root);
    expect(templates.map((t) => t.id).sort()).toEqual(['CustomTemplate', 'EmptyAbility']);
  });

  it('reads label/description/defaultModuleName from template.json', () => {
    writeMinimalTemplate(root, 'EmptyAbility');
    const [t] = listTemplates(root);
    expect(t!.label).toBe('Empty Ability');
    expect(t!.description).toBe('Minimal test fixture');
    expect(t!.defaultModuleName).toBe('entry');
  });

  it('falls back to inferred label when template.json is missing', () => {
    const dir = path.join(root, 'BareTemplate');
    fs.mkdirSync(dir, { recursive: true });
    const [t] = listTemplates(root);
    expect(t?.id).toBe('BareTemplate');
    expect(t?.label).toBe('Bare Template');
    expect(t?.defaultModuleName).toBe('entry');
  });

  it('sorts results by label', () => {
    writeMinimalTemplate(root, 'ZTemplate');
    writeMinimalTemplate(root, 'ATemplate');
    const ids = listTemplates(root).map((t) => t.id);
    expect(ids[0]).toBe('ATemplate');
    expect(ids[1]).toBe('ZTemplate');
  });
});

describe('validateTemplateLayout', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-validate-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty list when all required files are present', () => {
    writeMinimalTemplate(root, 'EmptyAbility');
    expect(validateTemplateLayout(path.join(root, 'EmptyAbility'), 'entry')).toEqual([]);
  });

  it('reports each missing required file', () => {
    writeMinimalTemplate(root, 'EmptyAbility');
    fs.rmSync(path.join(root, 'EmptyAbility', 'hvigorfile.ts'));
    fs.rmSync(path.join(root, 'EmptyAbility', 'AppScope', 'app.json5'));
    const missing = validateTemplateLayout(path.join(root, 'EmptyAbility'), 'entry');
    expect(missing).toContain('hvigorfile.ts');
    expect(missing).toContain(path.join('AppScope', 'app.json5'));
    expect(missing).toHaveLength(2);
  });
});
