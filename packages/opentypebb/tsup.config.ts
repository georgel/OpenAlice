import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  splitting: true,
  // Cross-package imports (Schwab broker pulls in @traderalice/ibkr) must be
  // resolved at runtime via node_modules, not bundled. Without this marker
  // tsup's esbuild pass tries to inline ibkr — which races with turbo's
  // parallel build of the ibkr package and fails on a cold cache.
  external: [
    '@traderalice/ibkr',
    'decimal.js',
  ],
})
