import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    // *.bun.test.ts files use bun:test + bun:sqlite — run them via `bun test`
    exclude: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**', '**/*.bun.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      include: ['packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
    },
  },
})
