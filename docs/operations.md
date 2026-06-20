# Operations

## Publishing the patched image to GHCR

The [`build-test-publish`](../.github/workflows/build-test-publish.yml) workflow publishes the
patched n8n image to GitHub Container Registry on every push to `main` (and via
`workflow_dispatch`). Pull requests only run the `e2e` gate — they never publish.

- **Image:** `ghcr.io/<owner>/n8n-proxy-auth`, tagged with the upstream version read from the
  Dockerfile `ARG N8N_VERSION` plus `:latest`. That ARG is the single source of truth for the
  version, shared with Renovate (see P3).
- **Auth:** the workflow uses the built-in `GITHUB_TOKEN` with `packages: write` — no PAT needed.
- **First publish:** the initial push to `main` creates the package. Afterward, in the package
  settings you can set its visibility (Package settings → Change visibility) and link it to this
  repo (Package settings → Connect repository). Use the lowercase `owner/repo` path for any manual
  pulls (`docker pull ghcr.io/<owner>/n8n-proxy-auth:<version>`).
- **Pre-flight:** `workflow_dispatch` runs the same publish path as a push to `main`, so you can
  exercise the GHCR auth + multi-arch build + attestation wiring once before relying on the push
  trigger.

## Branch protection (the required check)

`main` **must** require the status check named **`e2e`** — the gate job in `build-test-publish`.
With Renovate's `platformAutomerge`, this required check is the **only** interlock that stops a
broken upstream bump from auto-merging and publishing (see [design §10](./design.md)). GitHub will
otherwise merge a green-less PR.

- The check name is the literal string **`e2e`** (the workflow job's `id` and `name` are both
  `e2e`). If that job is ever renamed, update this doc **and** the branch-protection rule together —
  a missing/renamed required check silently defeats the interlock.
- Branch protection lives in GitHub repo settings, not in this repo, so it must be configured once
  by hand: Settings → Branches → add a rule for `main` → "Require status checks to pass" → select
  `e2e`.

## Optional real-Pomerium smoke (P4) — NOT a required check

A higher-fidelity, **non-gating** smoke runs **real Pomerium** + a static OIDC IdP (Dex) in front
of the patched n8n image, to catch drift in the real Pomerium `iss`/`aud`/JWKS specifics the
hermetic mock-JWKS gate cannot. It is **optional** and is deliberately **not** wired into CI, the
required `e2e` check, the GitHub workflows, or Renovate.

- **Stack:** [`e2e/docker-compose.pomerium.yml`](../e2e/docker-compose.pomerium.yml) — `dex`
  (static IdP, one fixed test user), `pomerium` (real, HTTPS, signs the ES256 assertion and injects
  `x-pomerium-jwt-assertion`), and `n8n` (the patched image). It uses a **distinct compose project**
  (`-p n8n-proxy-auth-p4`) and **distinct host ports** (Pomerium `8443`, n8n diagnostic `5710`) from
  the gating stack (which publishes `5699`), so the two cannot collide.
- **Secrets/TLS:** generated per run by [`e2e/gen-pomerium.ts`](../e2e/gen-pomerium.ts) into the
  gitignored `e2e/pomerium/.generated/` (Pomerium ES256 signing key, a self-signed CA + leaf cert,
  cookie/shared secrets). The committed `e2e/pomerium/config.yaml` references them **by path** —
  **no private key is ever inlined**. n8n trusts the generated CA via `NODE_EXTRA_CA_CERTS` (not
  `NODE_TLS_REJECT_UNAUTHORIZED=0`). Requires `openssl` on `PATH`.

### Running it

```sh
./scripts/e2e.pomerium.sh        # builds the image, generates secrets/TLS, brings the stack up
```

### What it asserts (tiered)

The exit criteria are **tiered** so the smoke is verifiable on its own. The split is honest about
what is session-**independent** (truly deterministic) versus what needs a real Pomerium session
(only as reliable as the OIDC login it depends on):

- **Mandatory tier (deterministic — needs no Pomerium session):**
  1. the **in-container HTTPS JWKS fetch** from n8n to Pomerium succeeds first (proves TLS trust +
     DNS), **before** any auth assertion;
  2. **NEGATIVE:** a structurally-valid ES256 assertion signed with the **wrong key** (an attacker
     key Pomerium's JWKS does not contain), sent directly to n8n, does **not** authenticate (no
     `Set-Cookie: n8n-auth`, `401`) — pinning the rejection to **signature verification** against
     Pomerium's JWKS, which is the header-trust invariant.
- **Best-effort tier (needs a Pomerium session):** capturing a live assertion inherently requires a
  session, and Pomerium uses the authorization-code flow (Dex's login **form**, not a single POST).
  The runner completes that flow programmatically — it walks Pomerium's sign-in redirect to Dex's
  static-password form, extracts the form action, and POSTs the credentials — which is possible
  because (a) `config.yaml` keeps the authenticate flow **on-cluster** (`authenticate_service_url:
https://authenticate.pomerium.localhost:8443`) instead of bouncing to Pomerium's hosted SaaS
  authenticate, and (b) the compose `dex` service **publishes its port** so the IdP login form is
  reachable for the client hop. When a session is obtained within `OIDC_LOGIN_ATTEMPTS` tries
  (default **3**):
  1. a **live Pomerium-minted** `x-pomerium-jwt-assertion` is captured (from `/.pomerium/jwt`, which
     `config.yaml` enables via the `pomerium_jwt_endpoint` runtime flag);
  2. its literal `iss`, `aud`, `alg`, and JWKS path are **decoded and recorded** to the run log;
  3. that **exact live token**, fed **directly** to the patched n8n (diagnostic port), yields
     `Set-Cookie: n8n-auth` **and** `200` on `/rest/login` — proving a **real** Pomerium assertion
     authenticates;
  4. a `/rest/login` probe driven **through real Pomerium** asserts the session authenticates
     (`200`). The hook issues `Set-Cookie: n8n-auth` on the **first** authenticated request and then,
     per the D6 reconcile, passes a matching cookie through **without** re-issuing — so an
     authenticated `200` (not a fresh `Set-Cookie` on every request) is the through-Pomerium proof.

  If a session cannot be obtained (e.g. a future Dex/Pomerium version changes the login form shape),
  the phase still **passes on the mandatory tier** and the live-token + through-Pomerium positives
  degrade to **documented-skip** — capture them manually (below) or via the optional Playwright UI
  smoke. A captured value that is not JWT-shaped (e.g. the sign-in HTML returned for an unauthorized
  session) is treated as "no live token" and never hard-fails this best-effort tier.

### Empirical iss / aud / JWKS (captured, hypothesis confirmed)

The real `iss`/`aud` are an **output** of this run, captured from a **live** token — see
[design §14](./design.md). The compose wiring uses the **bare route host**
(`n8n.pomerium.localhost`, no scheme) as the working hypothesis for both `iss` and `aud` and the
JWKS at `https://n8n.pomerium.localhost/.well-known/pomerium/jwks.json`.

A live assertion captured from **Pomerium v0.30.4** in this stack **confirms the hypothesis**:

```
alg = ES256
iss = "n8n.pomerium.localhost"   # bare route host, no scheme, no trailing slash
aud = "n8n.pomerium.localhost"   # iss == aud
JWKS = /.well-known/pomerium/jwks.json (on the route host; ES256 key, use:sig)
```

This matches Pomerium's default `jwt_issuer_format` (`IssuerHostOnly`), which emits `iss == aud ==`
the route hostname with **no scheme and no trailing slash**; since the verifier exact-matches `iss`,
a schemed value would reject every genuine assertion. No reconciliation of the Pomerium preset
(`src/pomerium-session-hook.ts`) or design §14 was needed — the captured literals equal the wired
values. The runner still re-records the decoded literals each run; if a future Pomerium version
emits different values it will surface immediately. The locked invariants — **mandatory non-empty
audience** on the env/deploy path and **ES256-only** pinning — are unchanged.

> **Route note (assertion injection).** The Pomerium route must **not** carry a route-level
> `remove_request_headers: [x-pomerium-jwt-assertion]` strip. Pomerium injects its own freshly
> signed assertion (and overwrites any client-supplied copy on ingress) whenever a `signing_key`
> is set and identity headers are passed; at v0.30.4 the route-level strip is applied to the
> request Pomerium **forwards upstream** and clobbers Pomerium's own injected assertion, leaving
> n8n with no header (the through-Pomerium probe then 401s). `e2e/pomerium/config.yaml` relies on
> Pomerium's built-in ingress replacement instead of an explicit strip.

If the programmatic capture cannot obtain a session, capture the assertion manually: complete the
login in a browser (add
`127.0.0.1 n8n.pomerium.localhost authenticate.pomerium.localhost dex.pomerium.localhost` to
`/etc/hosts` — all three hosts, since the auth-code flow visits the on-cluster authenticate host and
the Dex login form — accept the self-signed cert), then open
`https://n8n.pomerium.localhost:8443/.pomerium/jwt` to read the raw assertion and decode it.

### Optional Playwright UI smoke — DEFAULT: SKIP

A browser-level smoke lives in [`e2e/playwright/`](../e2e/playwright/) behind a **binary go/no-go
rule** (see that directory's `README.md`). It is **not** in the gating toolchain: `@playwright/test`
and its browser binaries are **not** repo dependencies, and `e2e/playwright/**` is excluded from
`tsc`/`eslint`. Include it **only** if `playwright install chromium` and the Dex login automate
cleanly in a small fixed number of attempts; otherwise keep it **documented-skip** and rely on the
HTTP-level smoke above. When run, it sets `ignoreHTTPSErrors` for the self-signed TLS, completes the
Dex login form, and asserts the browser lands on the workflow canvas, not `/signin`.

## Automated upstream tracking (Renovate)

[`renovate.json`](../renovate.json) keeps the patched image moving with upstream n8n, hands-off:

- **What it tracks:** Renovate's `dockerfile` manager bumps the `ARG N8N_VERSION` line in the
  Dockerfile (image stays in `FROM`, version in `ARG`). `pinDigests` also pins/refreshes the base
  image digest; digest-bump PRs flow through the same gate.
- **Channel:** `versioning: semver` + `allowedVersions: /^\d+\.\d+\.\d+$/` follows only stable
  releases — it excludes `next`, `beta`, `latest`, and `2.x.y-<sha>` tags.
- **Auto-merge:** `automerge` + `platformAutomerge` let a bump merge **only** once the required
  `e2e` check is green. A bad upstream bump fails e2e and parks as a red PR instead of publishing —
  this is the auto-update interlock from [design §10](./design.md). It depends entirely on the
  branch-protection rule above; without the required `e2e` check, GitHub could merge a bump with no
  passing tests.
- **Hosting:** the Mend-hosted Renovate GitHub App (decision D5) — install it on the repo; no
  self-hosted runner needed. Auto-merge behavior is identical either way.
