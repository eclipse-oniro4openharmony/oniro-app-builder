import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TemplateOption {
  id: string;
  label: string;
  description: string;
  defaultModuleName: string;
}

interface TemplateMeta {
  id?: string;
  label?: string;
  description?: string;
  defaultModuleName?: string;
}

function toHumanTemplateName(folderName: string): string {
  return folderName.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Enumerate templates inside `templateRoot`. Each direct subfolder is a template;
 * per-template metadata (label/description/defaultModuleName) may live in a
 * `template.json` file alongside the template content.
 *
 * Callers own the template root — the CLI ships its own under
 * `<cli-package>/templates/`, the VS Code extension uses `extensionPath/template`.
 */
export function listTemplates(templateRoot: string): TemplateOption[] {
  if (!fs.existsSync(templateRoot)) return [];
  const entries = fs.readdirSync(templateRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(templateRoot, e.name);
      const metaPath = path.join(dir, 'template.json');
      let meta: TemplateMeta = {};
      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TemplateMeta;
        } catch {
          // Ignore malformed template metadata.
        }
      }
      return {
        id: e.name,
        label: meta.label ?? toHumanTemplateName(e.name),
        description: meta.description ?? '',
        defaultModuleName: (meta.defaultModuleName ?? 'entry').trim() || 'entry',
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Verify that a template directory contains the files required by the scaffold pipeline.
 * Returns the list of missing relative paths, or [] if the template is complete.
 */
export function validateTemplateLayout(templateDir: string, defaultModuleName: string): string[] {
  const required = [
    'build-profile.json5',
    path.join('AppScope', 'app.json5'),
    path.join(defaultModuleName, 'src', 'main', 'module.json5'),
    path.join(defaultModuleName, 'oh-package.json5'),
    'hvigorfile.ts',
  ];
  return required.filter((rel) => !fs.existsSync(path.join(templateDir, rel)));
}
