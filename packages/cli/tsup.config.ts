import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: { 'oniro-app': 'src/bin/oniro-app.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
});
