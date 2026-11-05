import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

// The vendored checker's `--fix` helpers, loaded without running the checker
// (it only runs under `require.main`).
const checker = createRequire(import.meta.url)('../vendor/deveco-cli/arkts-check.cjs') as {
  extractNotAModule(message: string): string | null;
  namedImportsFrom(source: string, importerAbs: string, declAbs: string): string[];
  buildExportEdit(content: string, name: string): { start: number; end: number; text: string } | null;
};

describe('--fix for "File is not a module"', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-arkts-fix-'));
    fs.mkdirSync(path.join(tmp, 'pages'));
    fs.mkdirSync(path.join(tmp, 'components'));
    fs.writeFileSync(path.join(tmp, 'components', 'Card.ets'), '@Component\nstruct Card {\n  build() {}\n}\n');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the declaring file from the diagnostic', () => {
    expect(checker.extractNotAModule("File '/p/entry/src/main/ets/components/Card.ets' is not a module.")).toBe(
      '/p/entry/src/main/ets/components/Card.ets',
    );
    expect(checker.extractNotAModule("Module '\"./X\"' declares 'Y' locally, but it is not exported.")).toBeNull();
  });

  it('takes the names the importer asks that file for, by their original name', () => {
    const importer = path.join(tmp, 'pages', 'Index.ets');
    const decl = path.join(tmp, 'components', 'Card.ets');
    const source = [
      "import { Card, CardStyle as Style, type CardProps } from '../components/Card';",
      "import Default from '../components/Card';",
      "import { Other } from '../components/Missing';",
    ].join('\n');
    expect(checker.namedImportsFrom(source, importer, decl)).toEqual(['Card', 'CardStyle', 'CardProps']);
  });

  it('puts export after the decorator chain', () => {
    const content = fs.readFileSync(path.join(tmp, 'components', 'Card.ets'), 'utf-8');
    const edit = checker.buildExportEdit(content, 'Card')!;
    expect(content.slice(0, edit.start) + edit.text + content.slice(edit.end)).toBe(
      '@Component\nexport struct Card {\n  build() {}\n}\n',
    );
  });
});
