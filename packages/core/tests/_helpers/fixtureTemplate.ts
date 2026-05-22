import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Creates a minimal-but-valid template tree at `<root>/<templateId>/` containing
 * all the files `validateTemplateLayout` requires plus the files
 * `updateTemplateConfigs` mutates. Returns the templateId for convenience.
 */
export function writeMinimalTemplate(root: string, templateId = 'EmptyAbility'): string {
  const dir = path.join(root, templateId);
  const moduleName = 'entry';
  fs.mkdirSync(dir, { recursive: true });

  // template.json metadata
  fs.writeFileSync(
    path.join(dir, 'template.json'),
    JSON.stringify({ id: templateId, label: 'Empty Ability', description: 'Minimal test fixture', defaultModuleName: moduleName }),
  );

  // build-profile.json5
  fs.writeFileSync(
    path.join(dir, 'build-profile.json5'),
    JSON.stringify({
      app: {
        products: [{ name: 'default', compileSdkVersion: 18, compatibleSdkVersion: 18 }],
      },
      modules: [{ name: moduleName, srcPath: `./${moduleName}` }],
    }),
  );

  // AppScope/app.json5
  fs.mkdirSync(path.join(dir, 'AppScope', 'resources', 'base', 'element'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AppScope', 'app.json5'),
    JSON.stringify({ app: { bundleName: 'com.template.placeholder' } }),
  );
  fs.writeFileSync(
    path.join(dir, 'AppScope', 'resources', 'base', 'element', 'string.json'),
    JSON.stringify({ string: [{ name: 'app_name', value: 'TemplateName' }] }),
  );

  // entry/src/main/module.json5
  fs.mkdirSync(path.join(dir, moduleName, 'src', 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, moduleName, 'src', 'main', 'module.json5'),
    JSON.stringify({ module: { name: moduleName, mainElement: 'EntryAbility' } }),
  );

  // entry/oh-package.json5
  fs.writeFileSync(
    path.join(dir, moduleName, 'oh-package.json5'),
    JSON.stringify({ name: moduleName, version: '1.0.0' }),
  );

  // hvigorfile.ts
  fs.writeFileSync(path.join(dir, 'hvigorfile.ts'), '// fixture hvigorfile\n');

  return templateId;
}
