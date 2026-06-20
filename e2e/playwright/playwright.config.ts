/**
 * OPTIONAL Playwright UI smoke config (P4) — DEFAULT: SKIP. See ./README.md for the binary
 * go/no-go rule. This file is EXCLUDED from the gating toolchain (tsconfig/eslint/prettier ignore
 * e2e/playwright/**) because @playwright/test is not a repo dependency; it is provided on demand
 * via `pnpm dlx`. Do NOT import this from any gated source.
 */
// eslint-disable-next-line import/no-unresolved -- @playwright/test is provided on demand via pnpm dlx
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.smoke.ts',
  timeout: 60_000,
  use: {
    // Self-signed TLS from e2e/gen-pomerium.ts.
    ignoreHTTPSErrors: true,
    baseURL: 'https://n8n.pomerium.localhost:8443',
  },
});
