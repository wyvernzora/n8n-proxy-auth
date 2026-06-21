# Maintenance

## Local Development

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run format
corepack pnpm run test
corepack pnpm run build
corepack pnpm run check
```

`pnpm run check` runs typecheck, ESLint, Prettier, unit tests, and the `tsup` build.

The bundle must remain a single self-contained CommonJS file at `dist/hook.cjs`. `jose` is bundled
into that file because the Docker image copies only `dist/hook.cjs` into `/opt/proxy-auth/`.

## Real-Image E2E Gate

The required e2e check builds the image and runs n8n against a mock JWKS service:

```sh
./scripts/e2e.sh n8n-proxy-auth:test
```

This is the load-bearing regression contract. It covers:

- hook boot survival;
- middleware splice installed before n8n route auth;
- valid assertion to native n8n cookie;
- cookie-only follow-up auth;
- JIT provisioning and same-email reuse;
- wrong issuer, audience, expiry, algorithm, signature, and duplicate-header failures;
- cookie/identity switch reconciliation;
- forced splice-skip boot survival.

Be conservative when editing e2e expectations. If an upstream n8n change breaks the gate, prefer
fixing the hook or surfacing the incompatibility before weakening the scenario.

## Optional Real-Pomerium Smoke

For higher fidelity against real Pomerium and Dex:

```sh
./scripts/e2e.pomerium.sh n8n-proxy-auth:test
```

This smoke is non-gating. It uses:

- `e2e/docker-compose.pomerium.yml`;
- generated Pomerium signing keys and TLS material under `e2e/pomerium/.generated/`;
- Pomerium HTTPS on host port `8443`;
- n8n diagnostic port `5710`;
- compose project `n8n-proxy-auth-p4`.

The mandatory tier verifies in-container HTTPS JWKS fetch and rejects a wrong-key assertion. When
the scripted Dex login succeeds, it also captures a live Pomerium assertion, logs the literal `iss`,
`aud`, `alg`, and JWKS path, feeds that token directly to n8n, and probes through Pomerium.

If scripted login cannot obtain a session, manually capture a token:

1. Add `127.0.0.1 n8n.pomerium.localhost authenticate.pomerium.localhost dex.pomerium.localhost` to
   `/etc/hosts`.
2. Open `https://n8n.pomerium.localhost:8443/` and complete the Dex login.
3. Open `https://n8n.pomerium.localhost:8443/.pomerium/jwt`.
4. Decode the JWT and compare its `iss`, `aud`, `alg`, and JWKS path with the deployment config.

The optional Playwright UI smoke under `e2e/playwright/` is intentionally outside the default
toolchain and has no repo dependency on `@playwright/test`.

## CI And Publishing

`.github/workflows/build-test-publish.yml` has one job named `e2e`.

On pull requests it:

1. installs dependencies;
2. runs `pnpm check`;
3. builds the Docker image as `n8n-proxy-auth:test`;
4. runs `./scripts/e2e.sh n8n-proxy-auth:test`.

On push to `main` or `workflow_dispatch`, after the same checks, it publishes a multi-arch image to
GHCR:

```text
ghcr.io/<owner>/n8n-proxy-auth:<N8N_VERSION>
ghcr.io/<owner>/n8n-proxy-auth:latest
```

The workflow uses `GITHUB_TOKEN` with `packages: write`; no PAT is required. The first publish
creates the GHCR package. Afterward, set package visibility and connect it to the repository in
GitHub package settings.

## Branch Protection

`main` must require the status check named `e2e`.

This is the auto-update interlock. Renovate uses platform automerge, so without a required `e2e`
check GitHub could merge an upstream n8n bump without the real-image gate passing.

If the workflow job name changes, update branch protection at the same time.

## Renovate

`renovate.json` tracks the `ARG N8N_VERSION` line in the Dockerfile.

Current policy:

- follow stable semver n8n tags only;
- pin base-image digests;
- automerge only after required checks are green;
- use the Mend-hosted Renovate GitHub App.

When Renovate opens a red n8n bump, treat it as an upstream compatibility investigation. Start with
the e2e failure and the n8n internal couplings in [Architecture](architecture.md).
