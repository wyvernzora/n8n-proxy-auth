import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
  type RemoteJWKSetOptions,
} from 'jose';

/**
 * A single trusted token issuer. The registry of these forms a closed allow-list:
 * a token is only ever verified against the entry whose {@link TrustedIssuer.issuer}
 * matches the token's (unverified) `iss`, using that entry's pinned configuration.
 */
export interface TrustedIssuer {
  /** Exact `iss` value to match for allow-list membership. */
  issuer: string;
  /** JWKS URI used to verify this issuer's tokens. */
  jwksUri: string;
  /** Accepted `aud` value(s). When omitted, the audience is not checked. */
  audiences?: string[];
  /** Pinned algorithm allow-list, e.g. `['ES256']`. Never derived from the token header. */
  algorithms: string[];
  /** Claim carrying the n8n login identity. Default `email`. */
  identityClaim?: string;
  /** Claim carrying group memberships. Default `groups`. */
  groupsClaim?: string;
  /** Claim carrying the display name. Default `name`. */
  nameClaim?: string;
  /** Optional coarse authorization gate: the token must carry at least one of these groups. */
  requiredGroups?: string[];
  /** Advanced/testing: options forwarded to jose's `createRemoteJWKSet` (e.g. a custom fetch). */
  remoteJwks?: RemoteJWKSetOptions;
}

export interface ProxyAuthConfig {
  /** Closed allow-list of trusted issuers. Must be non-empty. */
  issuers: TrustedIssuer[];
  /** Clock-skew tolerance for `exp`/`nbf`/`iat`, in seconds. Default 60. */
  clockToleranceSec?: number;
}

export interface VerifiedIdentity {
  /** The matched issuer's `iss`. */
  issuer: string;
  /** The token's `sub`. */
  subject: string;
  /** The mapped login identity (value of the issuer's identity claim, default `email`). */
  identity: string;
  /** Convenience copy of the `email` claim, when present. */
  email?: string;
  /** Display name, when present. */
  name?: string;
  /** Group memberships, possibly empty. */
  groups: string[];
  /** The full verified payload, for callers that need additional claims. */
  claims: JWTPayload;
}

export type IdentityVerifier = (token: string) => Promise<VerifiedIdentity>;

interface CompiledIssuer {
  config: TrustedIssuer;
  jwks: ReturnType<typeof createRemoteJWKSet>;
}

const DEFAULT_CLOCK_TOLERANCE_SEC = 60;
const DEFAULT_IDENTITY_CLAIM = 'email';
const DEFAULT_GROUPS_CLAIM = 'groups';
const DEFAULT_NAME_CLAIM = 'name';

/**
 * Builds a verifier over a closed issuer allow-list. Verification:
 *   1. read the token's unverified `iss` and select the matching allow-listed issuer
 *      (reject immediately, without any network call, if it is not allow-listed);
 *   2. verify signature + `iss` + `aud` with the issuer's pinned algorithm allow-list;
 *   3. map the configured claims into a {@link VerifiedIdentity}, enforcing any required groups.
 */
export function createIdentityVerifier(config: ProxyAuthConfig): IdentityVerifier {
  if (config.issuers.length === 0) {
    throw new Error('createIdentityVerifier requires at least one trusted issuer.');
  }

  const compiled = new Map<string, CompiledIssuer>();
  for (const issuer of config.issuers) {
    compiled.set(issuer.issuer, {
      config: issuer,
      jwks: createRemoteJWKSet(new URL(issuer.jwksUri), issuer.remoteJwks),
    });
  }

  const clockTolerance = config.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;

  return async function verifyToken(token: string): Promise<VerifiedIdentity> {
    const declaredIssuer = readUnverifiedIssuer(token);
    const match = compiled.get(declaredIssuer);
    if (match === undefined) {
      throw new Error(`Issuer is not allow-listed: ${declaredIssuer}`);
    }

    const { config: issuer, jwks } = match;
    const verifyOptions: JWTVerifyOptions = {
      algorithms: issuer.algorithms,
      issuer: issuer.issuer,
      clockTolerance,
    };
    if (issuer.audiences !== undefined) {
      verifyOptions.audience = issuer.audiences;
    }

    const { payload } = await jwtVerify(token, jwks, verifyOptions);
    return mapIdentity(issuer, payload);
  };
}

/**
 * Returns the first usable token among the configured source headers, in order.
 * The `authorization` header is parsed as a `Bearer` token; every other header is
 * taken verbatim. Header names are matched case-insensitively.
 */
export function selectToken(
  headers: Record<string, string | string[] | undefined>,
  sourceHeaders: string[],
): string | undefined {
  for (const headerName of sourceHeaders) {
    const lower = headerName.toLowerCase();
    const rawValue = headers[lower];
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }

    if (lower === 'authorization') {
      const bearer = BEARER_PATTERN.exec(value)?.groups?.token;
      if (bearer !== undefined && bearer.length > 0) {
        return bearer;
      }
      continue;
    }

    return value;
  }

  return undefined;
}

const BEARER_PATTERN = /^Bearer\s+(?<token>.+)$/i;

function readUnverifiedIssuer(token: string): string {
  const { iss } = decodeJwt(token);
  if (typeof iss !== 'string' || iss.length === 0) {
    throw new Error('Token is missing an issuer (iss) claim.');
  }
  return iss;
}

function mapIdentity(issuer: TrustedIssuer, payload: JWTPayload): VerifiedIdentity {
  const subject = optionalStringClaim(payload.sub);
  if (subject === undefined) {
    throw new Error('Token is missing a subject (sub) claim.');
  }

  const identityClaim = issuer.identityClaim ?? DEFAULT_IDENTITY_CLAIM;
  const identity = optionalStringClaim(payload[identityClaim]);
  if (identity === undefined) {
    throw new Error(`Token is missing identity claim '${identityClaim}'.`);
  }

  const groups = stringArrayClaim(payload[issuer.groupsClaim ?? DEFAULT_GROUPS_CLAIM]);
  if (issuer.requiredGroups !== undefined && issuer.requiredGroups.length > 0) {
    const satisfied = issuer.requiredGroups.some((group) => groups.includes(group));
    if (!satisfied) {
      throw new Error('Token does not carry any of the required groups.');
    }
  }

  const result: VerifiedIdentity = {
    issuer: issuer.issuer,
    subject,
    identity,
    groups,
    claims: payload,
  };

  const email = optionalStringClaim(payload.email);
  if (email !== undefined) {
    result.email = email;
  }

  const name = optionalStringClaim(payload[issuer.nameClaim ?? DEFAULT_NAME_CLAIM]);
  if (name !== undefined) {
    result.name = name;
  }

  return result;
}

function optionalStringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayClaim(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}
