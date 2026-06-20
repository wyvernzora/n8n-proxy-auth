import { type RemoteJWKSetOptions } from 'jose';

import { createIdentityVerifier, type IdentityVerifier } from './verify.js';

/** Default algorithm for proxy-signed assertions. */
export const defaultJwtAssertionAlgorithms: readonly string[] = ['ES256'];

/** Default login identity claim. n8n account lookup still requires the verified `email` claim. */
export const defaultJwtAssertionIdentityClaim = 'email';

export interface JwtAssertionVerifierOptions {
  /** Signing JWKS URI for the trusted issuer. */
  jwksUrl: string | URL;
  /** Exact expected `iss` value. */
  issuer: string;
  /**
   * Expected `aud`. When omitted, the audience is not checked. The env/deploy path still requires a
   * non-empty audience so tokens are bound to this n8n instance.
   */
  audience?: string | string[];
  /** Pinned algorithm allow-list. Defaults to `['ES256']`. */
  algorithms?: string[];
  /** Advanced/testing: options forwarded to jose's `createRemoteJWKSet`. */
  remoteJwks?: RemoteJWKSetOptions;
}

/**
 * Convenience wrapper over the generic {@link createIdentityVerifier}: a one-entry issuer
 * allow-list for a proxy-signed JWT assertion.
 */
export function createJwtAssertionVerifier(options: JwtAssertionVerifierOptions): IdentityVerifier {
  return createIdentityVerifier({
    issuers: [
      {
        issuer: options.issuer,
        jwksUri: options.jwksUrl instanceof URL ? options.jwksUrl.href : options.jwksUrl,
        algorithms: options.algorithms ?? [...defaultJwtAssertionAlgorithms],
        identityClaim: defaultJwtAssertionIdentityClaim,
        ...(options.audience !== undefined ? { audiences: toAudienceArray(options.audience) } : {}),
        ...(options.remoteJwks !== undefined ? { remoteJwks: options.remoteJwks } : {}),
      },
    ],
  });
}

function toAudienceArray(audience: string | string[]): string[] {
  return Array.isArray(audience) ? audience : [audience];
}
