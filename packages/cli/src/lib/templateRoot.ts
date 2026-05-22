import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the bundled `templates/` directory shipped inside this CLI package.
 *
 * The CLI's `dist/oniro-app.js` lives at `<pkg>/dist/oniro-app.js` after build
 * and the templates ship at `<pkg>/templates/`. During development the entrypoint
 * lives at `<pkg>/src/bin/oniro-app.ts` so we also try `../../templates` from there.
 */
export function getBundledTemplateRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../templates'), // dist/oniro-app.js → ../templates
    path.resolve(here, '../../templates'), // src/bin/oniro-app.ts → ../../templates
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Return the most likely path even if it doesn't exist yet; createScaffold will
  // surface a clear error from there.
  return candidates[0]!;
}
