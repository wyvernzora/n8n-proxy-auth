import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The unit gate (`pnpm test`, part of `pnpm run check`) discovers ONLY the
    // Layer-1 + hook unit specs under test/. The Docker-dependent e2e spec lives
    // under e2e/ and is run exclusively by scripts/e2e.sh via vitest.e2e.config.ts.
    include: ['test/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
    },
    environment: 'node',
    globals: true,
  },
});
