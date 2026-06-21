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
into that file because deployed n8n containers mount only the hook artifact, not this repo's
`node_modules`.

## Real-Image E2E Gate

The required e2e check builds the hook artifact image and runs official n8n against a mock JWKS
service:

```sh
./scripts/e2e.sh n8n-proxy-auth-hook:test
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
./scripts/e2e.pomerium.sh n8n-proxy-auth-hook:test
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

## CI

`.github/workflows/build-test-publish.yml` has one job named `e2e`.

On pull requests it:

1. installs dependencies;
2. runs `pnpm check`;
3. builds the hook artifact image as `n8n-proxy-auth-hook:test`;
4. runs `./scripts/e2e.sh n8n-proxy-auth-hook:test` against official n8n.

On push to `main` or `workflow_dispatch`, it runs the same checks without publishing. Release tags
are the only publishing path.

## Releases

Releases are tag-driven through `.github/workflows/release.yaml`.

Create an annotated semver tag on a commit that is already on `main` and has a successful
`build-test-publish.yml` push run:

```sh
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The release workflow verifies the tag points at `origin/main`, verifies the existing e2e gate passed
for that exact commit, rebuilds the hook, publishes:

```text
ghcr.io/<owner>/n8n-proxy-auth-hook:v0.1.0
n8n-proxy-auth-hook-v0.1.0.tar.gz
```

and creates the GitHub release. The tarball contains `n8n-proxy-auth-hook/hook.cjs` plus a sibling
`.sha256` checksum asset. `workflow_dispatch` is available for rerunning an existing tag by passing
the same `vX.Y.Z` version.

## Branch Protection

`main` must require the status check named `e2e`.

This is the auto-update interlock. Renovate uses platform automerge, so without a required `e2e`
check GitHub could merge an upstream n8n bump without the real-image gate passing.

If the workflow job name changes, update branch protection at the same time.

## Renovate

`renovate.json` tracks `e2e/n8n-version`, which is the official n8n image version used by the
compatibility e2e harness. This is not a shipped version pin; consuming IaC should pin both
`n8nio/n8n` and `ghcr.io/<owner>/n8n-proxy-auth-hook` directly.

Current policy:

- follow stable semver n8n tags for the compatibility harness;
- pin Docker digests where Renovate can see image references;
- automerge only after required checks are green;
- use the Mend-hosted Renovate GitHub App.

When Renovate opens a red n8n bump, treat it as an upstream compatibility investigation. Start with
the e2e failure and the n8n internal couplings in [Architecture](architecture.md).
