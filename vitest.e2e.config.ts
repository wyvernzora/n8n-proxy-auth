import { defineConfig } from 'vitest/config';

/**
 * E2E vitest config — invoked ONLY by scripts/e2e.sh, never by `pnpm test`.
 * It discovers the Docker-dependent host driver spec and gives it a long
 * timeout (real HTTP round-trips against the patched n8n container).
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The scenarios provision users and reconcile cookies against a single
    // shared container; run them in-order within a single file, serially.
    fileParallelism: false,
  },
});
