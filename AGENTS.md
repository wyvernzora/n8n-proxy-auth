# AGENTS.md

Drop-in operating instructions for coding agents working on **n8n-proxy-auth**. Read the
user-global rules first:

- `~/.agents/AGENTS.md` - universal agent-behavior rules (non-negotiables, simplicity, surgical changes, communication style, grilling, etc.)

This file holds project-specific context, learnings, and overrides only. Rules in the global file
apply unless explicitly contradicted here.

The canonical references are:

- [`README.md`](README.md) - deployment surface and operator-facing configuration.
- [`docs/architecture.md`](docs/architecture.md) - hook design, n8n couplings, security invariants.
- [`docs/maintenance.md`](docs/maintenance.md) - local dev, e2e, CI, publishing, Renovate.

---

## 1. Project context

### About n8n-proxy-auth

- **Name:** n8n-proxy-auth.
- **Domain:** external hook artifact that lets a JWKS-backed proxy be the identity layer for self-hosted n8n Community.
- **Product shape:** one n8n external hook. No n8n source fork, no OAuth client flow, no web UI.
- **Access model:** the proxy is the access-control gate. Verified identities are provisioned as n8n `global:member`; owner setup is out of band.
- **Distribution:** GitHub release tarball plus `ghcr.io/<owner>/n8n-proxy-auth-hook:vX.Y.Z` one-shot installer image. Operators run official `n8nio/n8n` and mount the hook at `EXTERNAL_HOOK_FILES`.

### Stack

- **Language:** TypeScript on Node 24.
- **Package manager:** pnpm via Corepack (`packageManager` in `package.json`).
- **Build:** `tsup`, single CJS artifact `dist/hook.cjs`.
- **Verifier:** `jose` bundled into the hook artifact.
- **Tests:** Vitest unit tests under `test/`; Docker-dependent e2e under `e2e/`.
- **Container:** Dockerfile builds only the hook installer image; it must not include n8n.
- **CI:** `.github/workflows/build-test-publish.yml`, job/check name `e2e`; tag releases via `.github/workflows/release.yaml`.

### Package map

- `src/verify.ts` - pure JWT verifier over a closed `TrustedIssuer[]` allow-list.
- `src/jwt-assertion.ts` - provider-neutral one-issuer JWT assertion helper.
- `src/hook.ts` - external-hook entrypoint loaded by n8n.
- `src/proxy-auth.ts` - n8n-coupled middleware splice, config, cookie reconciliation, provisioning, and cookie issuance.
- `test/` - unit tests for verifier and hook config/install behavior.
- `e2e/` - mock-JWKS real-image gate plus optional real-Pomerium stack.
- `scripts/e2e.sh` - required real-image e2e runner.
- `scripts/e2e.pomerium.sh` - optional non-gating real-Pomerium smoke.

### Commands

```sh
corepack pnpm install
corepack pnpm run check
corepack pnpm run build
./scripts/e2e.sh n8n-proxy-auth-hook:test
./scripts/e2e.pomerium.sh n8n-proxy-auth-hook:test
```

Use focused unit tests during iteration (`corepack pnpm exec vitest run test/hook.test.ts`). Run
`corepack pnpm run check` before handing back code changes. Run `./scripts/e2e.sh` when touching the
hook, Dockerfile, e2e harness, CI gate, or n8n-facing behavior.

---

## 2. Invariants

- Keep the shipped artifact as one CJS file: `dist/hook.cjs`.
- Keep `jose` bundled into `dist/hook.cjs`; deployed n8n containers do not mount `node_modules` beside the hook.
- Do not add n8n as a repo dependency. n8n internals are resolved lazily inside the n8n process via the anchored `createRequire`.
- Do not replace `AuthService.issueCookie` with hand-rolled cookie/JWT signing.
- Do not trust plaintext identity headers. The auth boundary is a verified JWT with issuer, audience, expiry, and pinned algorithm checks.
- Do not allow symmetric `HS*` algorithms for JWKS issuers.
- Keep account lookup keyed by normalized verified email.
- Reconcile cookies against the verified proxy identity; do not let a valid stale cookie override a different valid proxy identity.
- Do not make proxy-authenticated users owners. First-run owner setup remains an explicit n8n operation.
- Keep n8n proxy-only in deployment docs and examples.
- The workflow job/check name `e2e` is branch-protection load-bearing. Renaming it requires updating docs and GitHub branch protection together.

### E2E expectations

The real-image e2e scenarios are regression contracts. Do not weaken or delete an existing e2e
assertion merely to make a change green. If an upstream n8n bump breaks a scenario, first determine
whether the hook needs to adapt or whether the project no longer supports that n8n version.

---

## 3. Project Learnings

**Accumulated corrections. This section is for the agent to maintain, not just the human.**

When the user corrects your approach, append a one-line rule here before ending the session. Write it
concretely ("Always use X for Y"), never abstractly ("be careful with Y"). If an existing line
already covers the correction, tighten it instead of adding a new one.

- (empty)
