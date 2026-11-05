import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // import.meta.url in the CJS build too: check/arktsCheck.ts finds the vendored checker by it.
  shims: true,
  target: 'node20',
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
});
