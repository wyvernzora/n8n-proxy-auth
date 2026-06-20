/**
 * OPTIONAL Playwright UI smoke (P4) — DEFAULT: SKIP. See ./README.md.
 *
 * A browser drives the full OIDC login THROUGH Pomerium (Dex static-password form) and asserts it
 * lands on the n8n workflow canvas, NOT /signin. Excluded from the gating toolchain; run only on
 * demand via `pnpm dlx` once the binary go/no-go rule in README.md passes.
 *
 * All three auth hosts must resolve to loopback (the auth-code flow visits the on-cluster
 * authenticate host and the Dex login form, not just the route host). Either add
 *   127.0.0.1 n8n.pomerium.localhost authenticate.pomerium.localhost dex.pomerium.localhost
 * to /etc/hosts, or rely on Playwright's host resolution. (*.localhost already resolves to
 * loopback on most systems.) The authenticate host and Dex are reached on their published ports
 * (Pomerium 8443; Dex 5556) — config.yaml sets authenticate_service_url to :8443 and the compose
 * dex service publishes 5556 so the redirect chain stays reachable without port rewriting.
 */
// eslint-disable-next-line import/no-unresolved -- @playwright/test is provided on demand via pnpm dlx
import { expect, test } from '@playwright/test';

const LOGIN_EMAIL = 'p4-user@pomerium.e2e.test';
const LOGIN_PASSWORD = 'Pomerium-P4-123';

test('a Pomerium-authenticated browser lands on the n8n canvas, not /signin', async ({ page }) => {
  // 1) Hit the protected route; Pomerium redirects into the Dex login.
  await page.goto('/');

  // 2) Complete Dex's static-password login form.
  await page.getByLabel(/email|login|username/i).fill(LOGIN_EMAIL);
  await page.getByLabel(/password/i).fill(LOGIN_PASSWORD);
  await page.getByRole('button', { name: /login|sign in|submit/i }).click();

  // 3) Pomerium injects the assertion; the hook issues the n8n session and n8n loads the app.
  await page.waitForLoadState('networkidle');

  // 4) We must be on the n8n app, NOT bounced to /signin.
  expect(page.url()).not.toContain('/signin');
  await expect(page.locator('#app, [data-test-id="main-sidebar"], .canvas')).toBeVisible({
    timeout: 30_000,
  });
});
