import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBundledTemplateRoot } from '../src/lib/templateRoot.js';

describe('getBundledTemplateRoot', () => {
  it('resolves to a directory that exists and contains EmptyAbility', () => {
    const root = getBundledTemplateRoot();
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, 'EmptyAbility'))).toBe(true);
  });

  it('the EmptyAbility template includes the required scaffold files', () => {
    const root = getBundledTemplateRoot();
    const template = path.join(root, 'EmptyAbility');
    expect(fs.existsSync(path.join(template, 'build-profile.json5'))).toBe(true);
    expect(fs.existsSync(path.join(template, 'AppScope', 'app.json5'))).toBe(true);
    expect(fs.existsSync(path.join(template, 'entry', 'oh-package.json5'))).toBe(true);
  });
});
