# Optional Playwright UI smoke (P4) — DEFAULT: SKIP

This is the **best-effort browser tier** of the P4 real-Pomerium smoke. It is intentionally
**not** part of the gating toolchain: `@playwright/test` and its browser binaries are **not** in
`package.json` devDependencies (a jose-only repo should not carry a browser engine), and this
spec is never run by `corepack pnpm run check` or `scripts/e2e.sh`.

## Binary go/no-go rule

Run the browser smoke **only if** all of the following install/automate cleanly:

1. `corepack pnpm dlx playwright@1 install chromium` succeeds (browser binary installs), and
2. the real-Pomerium stack is up (`scripts/e2e.pomerium.sh` reached at least its mandatory tier),
   and
3. the Dex login form automates in a small fixed number of attempts.

If any of those balloons dependency weight or flakes, **stop**: the HTTP-level real-Pomerium smoke
(`scripts/e2e.pomerium.sh`) is the P4 deliverable, and the browser part is **documented-skip**.

## Running it (only when the rule passes)

```sh
# Bring the stack up first.
./scripts/e2e.pomerium.sh        # mandatory tier; leave the stack up if iterating manually

# Install a single browser on demand (NOT added to package.json).
corepack pnpm dlx playwright@1 install chromium

# Run the smoke with playwright provided on demand.
corepack pnpm dlx --package=@playwright/test@1 playwright test \
  --config e2e/playwright/playwright.config.ts
```

The spec sets `ignoreHTTPSErrors` (self-signed TLS from `gen-pomerium.ts`), completes the Dex
login form, and asserts the browser lands on the n8n workflow canvas — **not** `/signin`.
