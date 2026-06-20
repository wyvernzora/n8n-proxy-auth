/**
 * Single source of truth for the e2e harness. These values feed BOTH the host
 * driver (which plays the identity proxy by minting JWTs) AND the n8n container env (via the
 * generated env_file), so iss/aud/jwksUri cannot drift between the two sides.
 */

/** The allow-listed issuer the patched n8n is configured to trust. */
export const TEST_ISSUER = 'https://issuer.e2e.test';

/** The audience the patched n8n is configured to require. */
export const TEST_AUDIENCE = 'n8n.e2e.test';

/** Pinned algorithm — asymmetric, JWKS-verifiable. */
export const TEST_ALGORITHM = 'ES256';

/**
 * A second asymmetric algorithm that is NOT in the pinned allow-list (scenario 5
 * unpinned-alg). Its public key IS published in the mock JWKS, so a token signed with
 * it has a verifiable signature — the rejection is attributable to the pinned-alg list.
 */
export const UNPINNED_ALGORITHM = 'RS256';

/** Compose-DNS URL the n8n container uses to fetch the mock JWKS (plain HTTP). */
export const MOCK_JWKS_URL = 'http://mock-jwks/jwks.json';

/** Base URL the host driver uses to reach the patched n8n (published port). */
export const N8N_PORT = 5699;
export const N8N_BASE_URL = `http://localhost:${String(N8N_PORT)}`;

/**
 * The endpoint every scenario probes. `GET /rest/login` returns 200 + the user
 * body when authenticated and 401 otherwise — the single 200-vs-401 discriminator.
 */
export const PROBE_PATH = '/rest/login';

/** The unauthenticated probe route the hook registers ONLY on a successful splice. */
export const INSTALL_PROBE_PATH = '/__proxy-auth/installed';

/** The trusted header carrying the bare compact JWS (NO `Bearer ` prefix). */
export const TRUSTED_HEADER = 'x-pomerium-jwt-assertion';

// Owner-setup credentials are NOT defined here: the fixture lives entirely in
// scripts/e2e.sh (bash cannot import this TS module), so keeping a copy here would be dead,
// drift-prone duplication. The single source of truth for the owner email/password is
// scripts/e2e.sh. Password there satisfies n8n's schema (8-64, uppercase, digit).

/**
 * Non-isbot User-Agent. abstract-server.js splices an isbot 204-filter BEFORE
 * cookieParser (botAllowedPaths === [] → 204 for ALL paths on a bot UA); pin a
 * benign UA so no scenario false-negatives via a 204.
 */
export const DRIVER_USER_AGENT = 'n8n-proxy-auth-e2e';

/** Values provably DIFFERENT from the trusted constants, for rejection scenarios. */
export const WRONG_ISSUER = 'https://attacker.e2e.invalid';
export const WRONG_AUDIENCE = 'some-other-app.e2e.invalid';

/** Generated artifacts (gitignored; produced by gen-env.ts per run). */
export const GENERATED_ENV_PATH = 'e2e/.generated.env';
export const JWKS_OUTPUT_PATH = 'e2e/mock-jwks/jwks.json';
