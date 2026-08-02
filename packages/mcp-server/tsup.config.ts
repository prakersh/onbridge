import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // @onbridge/shared is a private workspace package that resolves to raw .ts and
  // is never published. Left external, the published bundle tries to import
  // TypeScript at runtime and dies — so it has to be bundled in.
  noExternal: [/^@onbridge\//],
  // No `banner` shebang here: src/index.ts already carries one and tsup preserves
  // it. Emitting both put a second shebang on line 2, which Node rejects as a
  // syntax error — it broke `npx onbridge` entirely.
});
