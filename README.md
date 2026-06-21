# n8n-proxy-auth

Run upstream [n8n](https://n8n.io) behind [Pomerium](https://www.pomerium.com) (or any
OIDC/JWKS identity-aware proxy) and have the proxy be the identity layer — no n8n login page.

A small [external hook](https://docs.n8n.io/hosting/configuration/external-hooks/) is loaded
into an otherwise-unmodified `n8nio/n8n` image. On each request it:

1. reads a proxy-signed JWT from a request header (default `X-Pomerium-Jwt-Assertion`),
2. verifies it against the issuer's JWKS — signature, **issuer allow-list**, audience, expiry, and a **pinned algorithm** (ES256),
3. maps the verified `email` to an n8n user (just-in-time provisioned as a member if new), and
4. issues an n8n-native session cookie via n8n's own `AuthService`, so the rest of n8n treats the request as logged in.

The repo stays narrow: the product source is the hook under `src/`; everything else (Docker, CI,
e2e, Renovate) is plumbing that wraps it. The patched image tracks upstream n8n automatically and
auto-publishes **only while the e2e suite proves the mechanism still works**.

> **Security premise:** the hook verifies a cryptographic signature, not a plaintext header — so a
> forged header can't impersonate a user without the proxy's signing key. That is **not** a licence
> to expose n8n directly: keep n8n reachable **only** through the proxy, and have the proxy strip
> client-supplied copies of the identity header. See [Security](#security).

## How it works

`n8n.ready` splices a middleware into the Express router stack immediately **after** `cookieParser`
and **before** n8n's per-route auth (a plain `app.use()` would run too late). Per request:

- No identity header, or the JWT fails verification → pass through untouched (n8n returns its normal
  401 / sign-in). A cookie is **never** trusted before the header verifies.
- Header verifies → the request is keyed by the verified `email`:
  - an existing `n8n-auth` cookie for the **same** identity passes through (no re-issue);
  - a **different** identity (or no/invalid cookie) → find-or-provision the user and issue a fresh
    `n8n-auth` cookie, injecting it into the current request so it authenticates immediately.
- Any error fails **safe** — the request continues unauthenticated; the hook never 500s, and an
  install-time failure leaves n8n booting with SSO disabled (logged).

## Quickstart

### 1. Build (or pull) the patched image

```sh
# build locally from the pinned upstream version (ARG N8N_VERSION in the Dockerfile)
docker build -t n8n-proxy-auth:local .
```

Once this repo is pushed to GitHub, CI publishes a multi-arch image to
`ghcr.io/<owner>/n8n-proxy-auth:<n8n-version>` and `:latest` (see [docs/operations.md](docs/operations.md)).

### 2. Configure and run behind the proxy

Minimum env (Pomerium example — values come from a **live** token, see the note below):

```sh
docker run -d --name n8n \
  -e N8N_PROXY_AUTH_JWKS_URL="https://n8n.example.com/.well-known/pomerium/jwks.json" \
  -e N8N_PROXY_AUTH_ISSUER="n8n.example.com" \
  -e N8N_PROXY_AUTH_AUDIENCE="n8n.example.com" \
  -e N8N_USER_MANAGEMENT_JWT_SECRET="<a long random secret>" \
  -e N8N_HOST="n8n.example.com" -e N8N_PROXY_HOPS=1 \
  n8n-proxy-auth:local
```

- `EXTERNAL_HOOK_FILES=/opt/proxy-auth/hook.cjs` is already baked into the image.
- Set `N8N_USER_MANAGEMENT_JWT_SECRET` to a stable value so issued cookies survive restarts.
- **First run:** complete n8n's one-time owner setup (the instance is gated behind `/setup` until an
  owner exists). SSO-provisioned users are created as members after that.

> **Pomerium `iss`/`aud`:** with Pomerium's default `jwt_issuer_format: IssuerHostOnly`, both `iss`
> and `aud` are the **bare route host** (no scheme, no trailing slash) — e.g. `n8n.example.com`.
> The verifier exact-matches `iss`, so a schemed value rejects every real token. Confirm the exact
> literals from a live token (`https://<route-host>/.pomerium/jwt`) if unsure; the optional
> real-Pomerium smoke ([docs/operations.md](docs/operations.md)) captures and records them.
>
> Do **not** add a route-level `remove_request_headers: [x-pomerium-jwt-assertion]` strip — Pomerium
> injects its own signed assertion (and overwrites client copies on ingress); a route strip clobbers
> it and the upstream sees no header.

## Configuration

All hook config is `N8N_PROXY_AUTH_*`. Simple single-issuer form:

| Env var                              | Default                                                                                                                             | Meaning                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `N8N_PROXY_AUTH_JWKS_URL`            | — (**required**)                                                                                                                    | Issuer JWKS URI (Pomerium: `https://<route-host>/.well-known/pomerium/jwks.json`)                           |
| `N8N_PROXY_AUTH_ISSUER`              | — (**required**)                                                                                                                    | Expected `iss` — the only allow-listed issuer                                                               |
| `N8N_PROXY_AUTH_AUDIENCE`            | — (**required**)                                                                                                                    | Expected `aud` (comma-sep). Mandatory non-empty — binds tokens to this n8n                                  |
| `N8N_PROXY_AUTH_ALGORITHMS`          | `ES256`                                                                                                                             | Pinned algorithm allow-list (comma-sep). Symmetric `HS*` is rejected                                        |
| `N8N_PROXY_AUTH_HEADER`              | `x-pomerium-jwt-assertion`, then `authorization`, `x-forwarded-access-token`, `x-auth-request-access-token`, `x-forwarded-id-token` | Source header(s), in order; first that yields a verifying token wins. `authorization` is parsed as `Bearer` |
| `N8N_PROXY_AUTH_EMAIL_CLAIM`         | `email`                                                                                                                             | Claim required for the token to be usable (account key is always the `email` claim)                         |
| `N8N_PROXY_AUTH_AUTO_PROVISION`      | `true`                                                                                                                              | JIT-create unknown users as members; set `false` to require pre-existing users                              |
| `N8N_PROXY_AUTH_CLOCK_TOLERANCE_SEC` | `60`                                                                                                                                | Clock-skew tolerance for `exp`/`nbf`/`iat`                                                                  |
| `N8N_PROXY_AUTH_ISSUERS`             | —                                                                                                                                   | Advanced: path to a JSON file of `TrustedIssuer[]` (multi-issuer; overrides the simple vars)                |

Any config error (missing required var, empty audience, a symmetric algorithm) disables SSO with a
clear log line rather than crashing n8n.

### Beyond Pomerium

The core is a generic "verify any OIDC/OAuth JWT against a JWKS with an issuer allow-list." For
non-Pomerium proxies, point `N8N_PROXY_AUTH_HEADER` at the header they emit (e.g. oauth2-proxy's
`x-forwarded-access-token` / `authorization: Bearer`), or use `N8N_PROXY_AUTH_ISSUERS` for multiple
issuers, each with its own `jwksUri`, `audiences`, `algorithms`, and `identityClaim`.

## Security

- **Verify, don't trust.** Signature + issuer allow-list + audience + **algorithm pinning** (ES256;
  symmetric algorithms rejected for JWKS issuers — defeats `alg` confusion).
- **Keep n8n proxy-only.** Header trust is only as good as the hop in front; bind n8n so it's
  reachable solely via the proxy, and have the proxy strip client-supplied identity headers.
- **HTTPS JWKS.** A plaintext-HTTP JWKS URL lets an on-path attacker substitute keys; the hook warns
  on non-HTTPS JWKS (allowed only for the hermetic test harness).
- **Fail safe.** Verification/runtime errors → unauthenticated pass-through; downstream n8n still
  independently validates the cookie it issued.
- **Access control is the proxy's job.** Every verified identity is provisioned as a member; there is
  no n8n-side allow-list (Pomerium's policy is the gate).

## Develop / test

```sh
corepack pnpm install
corepack pnpm run check       # typecheck + eslint + prettier + unit tests + tsup build
corepack pnpm hooks:install   # one-time, repo-local git hooks
```

- **Unit tests** (`test/`) cover the pure verifier core (allow-list, alg-pinning, claim mapping).
- **e2e gate** — the real mechanism against the built image (mock JWKS + a driver that plays
  Pomerium, plus a boot-survival check). This is the required CI check:

  ```sh
  ./scripts/e2e.sh            # builds the image, runs the docker-compose e2e (needs Docker)
  ```

- **Optional real-Pomerium smoke** — real Pomerium + a static OIDC IdP (Dex), non-gating:

  ```sh
  ./scripts/e2e.pomerium.sh
  ```

## CI & releases

A single GitHub Actions workflow ([`.github/workflows/build-test-publish.yml`](.github/workflows/build-test-publish.yml))
runs `pnpm check` + the e2e gate on every PR (the required `e2e` check) and publishes the multi-arch
image to GHCR on push to `main`. [Renovate](renovate.json) tracks upstream n8n (stable tags only,
digests pinned) and auto-merges bumps **only** behind the green `e2e` check. Operational setup —
branch protection, GHCR, Renovate install — is in [docs/operations.md](docs/operations.md).

## Layout & docs

| Path                                                         | What                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `src/verify.ts`                                              | Layer 1 — generic JWKS/issuer-allow-list verifier + header precedence      |
| `src/pomerium-session-hook.ts`                               | Pomerium preset over the generic core                                      |
| `src/hook.ts`, `src/proxy-auth.ts`                           | Layer 2 — the n8n external hook (splice, reconcile, provision, cookie)     |
| `Dockerfile`                                                 | Thin patch over `n8nio/n8n` (ARG-pinned); copies the built `dist/hook.cjs` |
| `e2e/`, `scripts/e2e*.sh`                                    | mock-JWKS gate + optional real-Pomerium smoke                              |
| [`docs/design.md`](docs/design.md)                           | Authoritative design + decisions (D1–D6)                                   |
| [`docs/operations.md`](docs/operations.md)                   | Deploy/CI/Renovate/branch-protection operations                            |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | Phased build plan (historical record)                                      |

## License

See [LICENSE](LICENSE).
