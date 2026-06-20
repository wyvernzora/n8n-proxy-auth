/**
 * Layer 2 logic — the n8n-coupled proxy-auth implementation.
 *
 * Imported by `src/hook.ts` (the `EXTERNAL_HOOK_FILES` entry n8n require()'s). On
 * `n8n.ready` it splices a middleware into the Express router stack immediately after
 * `cookieParser`, so it runs BEFORE n8n's per-route auth. The middleware verifies a
 * proxy-signed JWT assertion (Layer 1), provisions/finds the user, and issues an
 * n8n-native session cookie.
 *
 * All n8n internals are resolved lazily through a SINGLE `createRequire` anchored at an
 * n8n dist file — the hook's own resolution base is `/opt/proxy-auth/`, where bare
 * `require('@n8n/di')` would MODULE_NOT_FOUND. Local interfaces + one `as` cast per
 * require boundary keep `strictTypeChecked` `no-unsafe-*` clean without depending on n8n.
 */
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';

import {
  defaultJwtAssertionAlgorithms,
  defaultJwtAssertionIdentityClaim,
} from './jwt-assertion.js';
import {
  createIdentityVerifier,
  selectToken,
  type IdentityVerifier,
  type ProxyAuthConfig,
  type TrustedIssuer,
  type VerifiedIdentity,
} from './verify.js';

// ---------------------------------------------------------------------------
// Local structural interfaces for the n8n surface we touch. These describe ONLY
// the members the hook uses; one `as` cast is applied at each require boundary.
// ---------------------------------------------------------------------------

interface RoleLike {
  slug: string;
}

interface UserLike {
  email?: string | null;
  role?: RoleLike;
}

interface AuthServiceLike {
  /** Public, side-effect-free: returns the cookie User (email + role loaded) or throws. */
  validateCookieToken(token: string): Promise<UserLike>;
  /** Writes `Set-Cookie: n8n-auth` to `res`. */
  issueCookie(
    res: ServerResponse,
    user: UserLike,
    usedMfa: boolean,
    browserId?: string,
    isEmbed?: boolean,
    cookieOverrides?: Record<string, unknown>,
  ): void;
}

interface UserRepositoryLike {
  findOne(options: { where: { email: string }; relations: string[] }): Promise<UserLike | null>;
  createUserWithProject(user: {
    email: string;
    firstName: string;
    lastName: string;
    role: RoleLike;
    password: string;
    authIdentities: unknown[];
  }): Promise<{ user: UserLike; project: unknown }>;
}

interface ContainerLike {
  get(token: unknown): unknown;
}

type ServiceCtor = abstract new (...args: never[]) => unknown;

interface DiModule {
  Container: ContainerLike;
}

interface DbModule {
  GLOBAL_MEMBER_ROLE: RoleLike;
  UserRepository: ServiceCtor;
}

interface AuthServiceModule {
  AuthService: ServiceCtor;
}

/** Minimal Express Layer constructor surface (reused from the live stack). */
type LayerCtor = new (
  path: string,
  options: Record<string, unknown>,
  handler: ExpressHandler,
) => unknown;

interface ExpressLayer {
  name: string;
  constructor: unknown;
}

type ExpressHandler = (
  req: ExpressRequest,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

interface ExpressRequest {
  url?: string;
  path?: string;
  headers: IncomingHttpHeaders;
  cookies?: Record<string, string | undefined>;
}

interface ExpressAppLike {
  router?: { stack: ExpressLayer[] };
  _router?: { stack: ExpressLayer[] };
}

interface AbstractServerLike {
  app: ExpressAppLike;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Runtime config: the Layer-1 verifier config plus Layer-2 concerns. */
export interface HookConfig {
  verifierConfig: ProxyAuthConfig;
  sourceHeaders: string[];
  autoProvision: boolean;
}

/** Design §5.1 default source-header precedence order. */
const DEFAULT_SOURCE_HEADERS: readonly string[] = [
  'x-pomerium-jwt-assertion',
  'authorization',
  'x-forwarded-access-token',
  'x-auth-request-access-token',
  'x-forwarded-id-token',
];

const DEFAULT_CLOCK_TOLERANCE_SEC = 60;
const PROVISION_PASSWORD = 'no password set';
const COOKIE_NAME = 'n8n-auth';
const INSTALLED_PROBE_PATH = '/__proxy-auth/installed';
/** Test-only fault injection (locked constraint 5): force the cookieParser-not-found branch. */
const FORCE_NO_COOKIEPARSER_ENV = 'N8N_PROXY_AUTH_FORCE_NO_COOKIEPARSER';

const ANCHOR = '/usr/local/lib/node_modules/n8n/dist/server.js';

/** Symmetric algorithms are rejected for JWKS-based issuers (asymmetric-key-as-HMAC confusion). */
function isSymmetricAlg(alg: string): boolean {
  return /^HS\d+$/i.test(alg);
}

function splitCsv(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse `N8N_PROXY_AUTH_*` into a {@link HookConfig}. Throws (→ SSO disabled via the
 * installProxyAuth try/catch) on an effectively-empty audience or algorithm set, and on
 * any symmetric (HS*) algorithm pinned for a JWKS-based issuer.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HookConfig {
  const issuersJsonPath = env.N8N_PROXY_AUTH_ISSUERS;
  const clockToleranceSec = parseClockTolerance(env.N8N_PROXY_AUTH_CLOCK_TOLERANCE_SEC);

  let issuers: TrustedIssuer[];
  if (issuersJsonPath !== undefined && issuersJsonPath.length > 0) {
    issuers = loadIssuersFromFile(issuersJsonPath);
  } else {
    issuers = [issuerFromSimpleEnv(env)];
  }

  for (const issuer of issuers) {
    validateIssuer(issuer);
  }

  const sourceHeaders = splitCsv(env.N8N_PROXY_AUTH_HEADER);

  return {
    verifierConfig: { issuers, clockToleranceSec },
    sourceHeaders: sourceHeaders.length > 0 ? sourceHeaders : [...DEFAULT_SOURCE_HEADERS],
    autoProvision: env.N8N_PROXY_AUTH_AUTO_PROVISION !== 'false',
  };
}

function parseClockTolerance(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_CLOCK_TOLERANCE_SEC;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid N8N_PROXY_AUTH_CLOCK_TOLERANCE_SEC: ${raw}`);
  }
  return value;
}

function issuerFromSimpleEnv(env: NodeJS.ProcessEnv): TrustedIssuer {
  const jwksUri = requireEnv(env, 'N8N_PROXY_AUTH_JWKS_URL');
  const issuer = requireEnv(env, 'N8N_PROXY_AUTH_ISSUER');
  const algorithms = splitCsv(env.N8N_PROXY_AUTH_ALGORITHMS);
  const audiences = splitCsv(env.N8N_PROXY_AUTH_AUDIENCE);

  return {
    issuer,
    jwksUri,
    algorithms: algorithms.length > 0 ? algorithms : [...defaultJwtAssertionAlgorithms],
    audiences,
    identityClaim: env.N8N_PROXY_AUTH_EMAIL_CLAIM ?? defaultJwtAssertionIdentityClaim,
  };
}

function loadIssuersFromFile(path: string): TrustedIssuer[] {
  // node:fs is a Node builtin (no resolution risk), so use a direct import rather than the
  // n8n-anchored createRequire — that anchor is reserved for n8n's nested-pnpm packages.
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`N8N_PROXY_AUTH_ISSUERS file must contain a TrustedIssuer[] array: ${path}`);
  }
  return parsed.map((entry, idx) => normalizeIssuerEntry(entry, idx));
}

function normalizeIssuerEntry(entry: unknown, idx: number): TrustedIssuer {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`N8N_PROXY_AUTH_ISSUERS[${String(idx)}] is not an object.`);
  }
  const obj = entry as Record<string, unknown>;
  const result: TrustedIssuer = {
    issuer: stringField(obj, 'issuer', idx),
    jwksUri: stringField(obj, 'jwksUri', idx),
    algorithms: stringArrayField(obj, 'algorithms'),
    audiences: stringArrayField(obj, 'audiences'),
  };
  if (typeof obj.identityClaim === 'string') {
    result.identityClaim = obj.identityClaim;
  }
  if (typeof obj.groupsClaim === 'string') {
    result.groupsClaim = obj.groupsClaim;
  }
  if (typeof obj.nameClaim === 'string') {
    result.nameClaim = obj.nameClaim;
  }
  if (Array.isArray(obj.requiredGroups)) {
    result.requiredGroups = obj.requiredGroups.filter((g): g is string => typeof g === 'string');
  }
  return result;
}

function stringField(obj: Record<string, unknown>, key: string, idx: number): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`N8N_PROXY_AUTH_ISSUERS[${String(idx)}].${key} must be a non-empty string.`);
  }
  return value;
}

function stringArrayField(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Audience-required + algorithm validation. The effective (trimmed, non-empty) audience set
 * must be non-empty: this closes Layer-1's only aud fail-open (an UNSET/undefined audience,
 * which jose forwards as "no aud check") and turns ''/[]/[''] from an opaque all-tokens-401
 * usability bug into a clear SSO-disabled diagnostic. ([]/[''] already fail closed in jose.)
 * Algorithms must be non-empty (diagnosability — jose fails closed on []) and must not pin
 * any symmetric HS* for a JWKS-based issuer.
 */
function validateIssuer(issuer: TrustedIssuer): void {
  const effectiveAudiences = (issuer.audiences ?? [])
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (effectiveAudiences.length === 0) {
    throw new Error(
      `Issuer '${issuer.issuer}' has no audience configured — SSO disabled. ` +
        `Set an audience (N8N_PROXY_AUTH_AUDIENCE) so tokens are bound to this n8n.`,
    );
  }
  // Normalize back onto the issuer so the verifier sees the trimmed set.
  issuer.audiences = effectiveAudiences;

  const effectiveAlgorithms = issuer.algorithms.map((a) => a.trim()).filter((a) => a.length > 0);
  if (effectiveAlgorithms.length === 0) {
    throw new Error(`Issuer '${issuer.issuer}' has no algorithms configured — SSO disabled.`);
  }
  const symmetric = effectiveAlgorithms.filter(isSymmetricAlg);
  if (symmetric.length > 0) {
    throw new Error(
      `Issuer '${issuer.issuer}' pins symmetric algorithm(s) ${symmetric.join(', ')}; ` +
        `only asymmetric algorithms are allowed for a JWKS-based issuer.`,
    );
  }
  issuer.algorithms = effectiveAlgorithms;

  warnIfInsecureJwksUri(issuer);
}

/**
 * Design §7 rests on the JWKS being fetched from a trustworthy source. A plaintext-HTTP
 * JWKS URL lets an on-path attacker substitute an attacker-controlled key set and forge
 * assertions that genuinely verify — defeating alg pinning and the iss/aud allow-list. We
 * WARN rather than reject: the e2e harness legitimately uses http://mock-jwks over a private
 * compose network (locked constraint 7), and a hard reject would break it.
 */
function warnIfInsecureJwksUri(issuer: TrustedIssuer): void {
  let protocol: string;
  try {
    protocol = new URL(issuer.jwksUri).protocol;
  } catch {
    return; // malformed URL surfaces later via jose; nothing to warn about here.
  }
  if (protocol !== 'https:') {
    logWarn(
      `WARNING: issuer '${issuer.issuer}' JWKS URL is not HTTPS (${issuer.jwksUri}) — ` +
        `assertions are forgeable by an on-path attacker; use HTTPS in production.`,
    );
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required env var ${key}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// n8n internal resolution (single anchored createRequire)
// ---------------------------------------------------------------------------

interface N8nInternals {
  authService: AuthServiceLike;
  userRepository: UserRepositoryLike;
  memberRole: RoleLike;
}

let cachedInternals: N8nInternals | undefined;

function resolveInternals(): N8nInternals {
  if (cachedInternals !== undefined) {
    return cachedInternals;
  }
  const n8nRequire = createRequire(ANCHOR);
  const { Container } = n8nRequire('@n8n/di') as DiModule;
  const { AuthService } = n8nRequire('./auth/auth.service.js') as AuthServiceModule;
  const { GLOBAL_MEMBER_ROLE, UserRepository } = n8nRequire('@n8n/db') as DbModule;

  cachedInternals = {
    authService: Container.get(AuthService) as AuthServiceLike,
    userRepository: Container.get(UserRepository) as UserRepositoryLike,
    memberRole: GLOBAL_MEMBER_ROLE,
  };
  return cachedInternals;
}

// ---------------------------------------------------------------------------
// Hook entrypoint
// ---------------------------------------------------------------------------

function logInfo(message: string): void {
  console.log(`[n8n-proxy-auth] ${message}`);
}

function logWarn(message: string): void {
  console.warn(`[n8n-proxy-auth] ${message}`);
}

function logError(message: string, err: unknown): void {
  console.error(`[n8n-proxy-auth] ${message}`, err instanceof Error ? err.stack : String(err));
}

/** n8n.ready handler: load config and install the splice. Boot survives any failure. */
export async function readyHook(server: AbstractServerLike): Promise<void> {
  // n8n awaits n8n.ready; keep this async-shaped but synchronous internally.
  await Promise.resolve();
  let config: HookConfig;
  try {
    config = loadConfigFromEnv();
  } catch (err) {
    logError('SSO disabled — configuration error', err);
    return;
  }
  installProxyAuth(server.app, config);
}

/**
 * Splice the proxy-auth middleware after the `cookieParser` layer. The entire body is
 * wrapped so any failure leaves n8n booting (n8n.ready is awaited unguarded and rethrows).
 * On a successful splice ONLY, register an unauthenticated probe route as the deterministic
 * splice-installed signal (204 when installed, 404 when skipped).
 */
export function installProxyAuth(app: ExpressAppLike, config: HookConfig): void {
  try {
    const stack = app.router?.stack ?? app._router?.stack;
    if (stack === undefined) {
      logError('SSO disabled — no Express router stack found', new Error('app.router missing'));
      return;
    }

    // Test-only fault injection (locked constraint 5): force the not-found branch.
    const forceNoCookieParser = process.env[FORCE_NO_COOKIEPARSER_ENV] === 'true';
    const cookieParserIdx = forceNoCookieParser
      ? -1
      : stack.findIndex((layer) => layer.name === 'cookieParser');

    if (cookieParserIdx < 0) {
      logInfo('SSO disabled — cookieParser layer not found; splice skipped');
      return;
    }

    const anchorLayer = stack[cookieParserIdx];
    if (anchorLayer === undefined) {
      logInfo('SSO disabled — cookieParser layer vanished; splice skipped');
      return;
    }
    const Layer = anchorLayer.constructor as LayerCtor | undefined;
    if (typeof Layer !== 'function') {
      logError(
        'SSO disabled — Layer constructor unavailable on the router stack',
        new Error('stack[i].constructor is not a function'),
      );
      return;
    }

    const verifier = createIdentityVerifier(config.verifierConfig);
    const middleware = makeMiddleware(config, verifier);
    // `end: false` makes the Layer a prefix match (run for ALL paths), mirroring how
    // Express registers `app.use` middleware. The default (`end: true`) would only match
    // the exact path '/', so the middleware would never run — a silent fail-open.
    const layer = new Layer('/', { end: false }, middleware) as ExpressLayer;
    stack.splice(cookieParserIdx + 1, 0, layer);

    logInfo(
      `proxy-auth middleware spliced after layer '${anchorLayer.name}' at index ${String(
        cookieParserIdx,
      )}`,
    );
  } catch (err) {
    // Boot must survive any install failure.
    logError('SSO disabled — proxy-auth install failed', err);
  }
}

// ---------------------------------------------------------------------------
// Per-request middleware
// ---------------------------------------------------------------------------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Build the per-request handler. Security invariant: the issue/inject path and the
 * reconcile comparison are unreachable unless selectToken + Layer-1 verify succeed on
 * THIS request — a cookie is never trusted before the header verifies. Any error →
 * next() unauthenticated; never 500, never authenticate.
 */
export function makeMiddleware(config: HookConfig, verifier: IdentityVerifier): ExpressHandler {
  return (req, res, next) => {
    // Splice-installed signal: this spliced middleware (which exists ONLY when the splice
    // succeeded) answers the probe path with 204, BEFORE n8n's SPA catch-all. When the
    // splice is skipped, this handler is absent and the SPA fallback answers 200 instead —
    // so 204-vs-non-204 is the deterministic installed-vs-skipped discriminator.
    if (requestPath(req) === INSTALLED_PROBE_PATH) {
      res.statusCode = 204;
      res.end();
      return;
    }
    void handleRequest(config, verifier, req, res)
      .then(() => {
        next();
      })
      .catch((err: unknown) => {
        logError('proxy-auth middleware error — passing through unauthenticated', err);
        next();
      });
  };
}

/** The request path without query string (Express sets `req.path`; fall back to `req.url`). */
function requestPath(req: ExpressRequest): string {
  if (typeof req.path === 'string') {
    return req.path;
  }
  const url = req.url ?? '';
  const queryIdx = url.indexOf('?');
  return queryIdx >= 0 ? url.slice(0, queryIdx) : url;
}

async function handleRequest(
  config: HookConfig,
  verifier: IdentityVerifier,
  req: ExpressRequest,
  res: ServerResponse,
): Promise<void> {
  // [1] Header FIRST. No token, or verify throws → pass through with zero side effects.
  const token = selectToken(req.headers, config.sourceHeaders);
  if (token === undefined) {
    return;
  }

  let identity: VerifiedIdentity;
  try {
    identity = await verifier(token);
  } catch {
    // Failed header verification — never trust a cookie on its face.
    return;
  }

  // [2] Account key = verified email. The account is ALWAYS keyed by the verified
  // `email` claim (find, JIT-create, and the D6 reconcile-compare all use this identical
  // value), regardless of N8N_PROXY_AUTH_EMAIL_CLAIM: identityClaim only gates presence in
  // Layer 1's mapIdentity, it does NOT change the account key (constraint 3, email-as-key).
  // email_verified is INTENTIONALLY NOT enforced (trust delegated to the configured issuer);
  // "verified email" == a present, signature-verified
  // email claim. No email → cannot key an account → pass through unauthenticated.
  if (identity.email === undefined || identity.email.trim().length === 0) {
    return;
  }
  const normalizedEmail = normalizeEmail(identity.email);

  const internals = resolveInternals();

  // [3] Reconcile (design D6): an existing cookie for the SAME identity passes through.
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken !== undefined && cookieToken.length > 0) {
    if (await cookieMatchesIdentity(internals, cookieToken, normalizedEmail)) {
      return; // same identity → no re-issue
    }
  }

  // [4] Find or JIT-provision, keyed by the normalized email; role loaded on both paths.
  const user = await findOrProvision(internals, config, identity, normalizedEmail);
  if (user === undefined) {
    return; // unknown user, provisioning disabled → unauthenticated
  }

  // [5] Issue a fresh cookie and inject the minted token so THIS request authenticates.
  internals.authService.issueCookie(res, user, true, undefined);
  injectIssuedCookie(req, res);

  // [6] next() — handled by makeMiddleware.
}

/**
 * Resolve the existing cookie via n8n's own side-effect-free validator and compare its
 * (nullable) email to the verified identity. A null/empty cookie email (e.g. the seeded
 * shell-owner row carries a null email) is treated as NOT-equal → fall through to re-issue,
 * so we never silently authenticate as the shell owner. Any throw → not-equal → re-issue.
 */
async function cookieMatchesIdentity(
  internals: N8nInternals,
  cookieToken: string,
  normalizedEmail: string,
): Promise<boolean> {
  try {
    const cookieUser = await internals.authService.validateCookieToken(cookieToken);
    const cookieEmail = cookieUser.email;
    if (cookieEmail === undefined || cookieEmail === null || cookieEmail.trim().length === 0) {
      return false;
    }
    return normalizeEmail(cookieEmail) === normalizedEmail;
  } catch {
    return false;
  }
}

async function findOrProvision(
  internals: N8nInternals,
  config: HookConfig,
  identity: VerifiedIdentity,
  normalizedEmail: string,
): Promise<UserLike | undefined> {
  const existing = await internals.userRepository.findOne({
    where: { email: normalizedEmail },
    relations: ['authIdentities', 'role'],
  });
  if (existing !== null) {
    return existing;
  }
  if (!config.autoProvision) {
    return undefined;
  }

  const { firstName, lastName } = deriveName(identity, normalizedEmail);
  const { user } = await internals.userRepository.createUserWithProject({
    email: normalizedEmail,
    firstName,
    lastName,
    role: internals.memberRole,
    password: PROVISION_PASSWORD,
    authIdentities: [],
  });
  return user;
}

function deriveName(
  identity: VerifiedIdentity,
  normalizedEmail: string,
): { firstName: string; lastName: string } {
  if (identity.name !== undefined && identity.name.trim().length > 0) {
    return { firstName: identity.name.trim(), lastName: '' };
  }
  const local = normalizedEmail.split('@')[0] ?? normalizedEmail;
  return { firstName: local, lastName: '' };
}

/**
 * Read the freshly-written `Set-Cookie: n8n-auth` from the response and inject its value
 * into `req.cookies['n8n-auth']` so n8n's per-route auth authenticates THIS request.
 * cookieParser runs with no secret, so downstream reads `req.cookies` (not signedCookies).
 */
function injectIssuedCookie(req: ExpressRequest, res: ServerResponse): void {
  const setCookie = res.getHeader('set-cookie');
  const entries = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];
  for (const entry of entries) {
    const prefix = `${COOKIE_NAME}=`;
    if (entry.startsWith(prefix)) {
      const value = entry.slice(prefix.length).split(';')[0];
      if (value !== undefined && value.length > 0) {
        req.cookies ??= {};
        req.cookies[COOKIE_NAME] = value;
      }
      return;
    }
  }
}

/** The hook object n8n loads: `{ n8n: { ready: [readyHook] } }`. */
export const hook = {
  n8n: {
    ready: [readyHook],
  },
};
