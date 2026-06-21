/**
 * Single source of truth for the OPTIONAL real-Pomerium smoke (P4). Non-gating: this stack
 * runs real Pomerium + a static OIDC IdP (Dex) in front of hooked n8n, to catch drift in
 * the real Pomerium iss/aud/JWKS specifics the mock-JWKS gate cannot.
 *
 * IMPORTANT (per the locked design's empirical TODO): the literal `iss` and `aud` carried by a
 * real Pomerium per-request assertion are NOT assumed here. scripts/e2e.pomerium.sh captures
 * them from a LIVE token and records them; the n8n env wiring below uses the ROUTE HOST as the
 * working hypothesis, and the runner asserts the captured values match what the verifier
 * accepts. If a live token shows otherwise, the runner surfaces the discrepancy and the docs/
 * preset are reconciled to the captured values — not the other way around.
 */

/** The route host clients (and n8n, via compose alias) use to reach n8n THROUGH Pomerium. */
export const POMERIUM_ROUTE_HOST = 'n8n.pomerium.localhost';

/** The Dex (mock OIDC IdP) host, fronted by its own Pomerium-independent listener. */
export const DEX_HOST = 'dex.pomerium.localhost';

/**
 * Pomerium's ON-CLUSTER authenticate host. `config.yaml` sets `authenticate_service_url` to this so
 * the sign-in redirect stays inside the compose network; without it Pomerium defaults to its HOSTED
 * authenticate service (authenticate.pomerium.app) and no local OIDC login can complete. Pomerium's
 * OIDC callback is `https://<this host>/oauth2/callback`, which Dex's redirectURIs must include.
 */
export const POMERIUM_AUTHENTICATE_HOST = 'authenticate.pomerium.localhost';

/** The static test identity Dex authenticates and Pomerium forwards as an assertion. */
export const POMERIUM_TEST_EMAIL = 'p4-user@pomerium.e2e.test';
export const POMERIUM_TEST_PASSWORD = 'Pomerium-P4-123';

/** Pomerium HTTPS listener, published on the host (the only host-published port for auth). */
export const POMERIUM_HTTPS_PORT = 8443;

/**
 * Diagnostic-only: n8n is host-published on a SEPARATE port ONLY for the negative
 * direct-bypass assertion (a self-supplied header sent straight to n8n must NOT authenticate).
 */
export const N8N_DIAGNOSTIC_PORT = 5710;

/** Pomerium's signing JWKS, served on the route host. The hook's trust anchor. */
export const POMERIUM_JWKS_PATH = '/.well-known/pomerium/jwks.json';

/** The header Pomerium injects to the upstream (and the one the hook reads). */
export const POMERIUM_ASSERTION_HEADER = 'x-pomerium-jwt-assertion';

/** The probe the runner drives THROUGH Pomerium / against n8n: 200 + body vs 401. */
export const PROBE_PATH = '/rest/login';

/** Generated (gitignored) secrets/TLS dir, written by e2e/gen-pomerium.ts. */
export const POMERIUM_GENERATED_DIR = 'e2e/pomerium/.generated';
