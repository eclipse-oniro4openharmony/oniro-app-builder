import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
});
