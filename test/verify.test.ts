import {
  customFetch,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type FetchImplementation,
  type JWK,
  type JWTPayload,
} from 'jose';
import { describe, expect, it } from 'vitest';

import { createIdentityVerifier, selectToken, type TrustedIssuer } from '../src/verify.js';

describe('createIdentityVerifier', () => {
  it('verifies a token from an allow-listed issuer and maps claims', async () => {
    const key = await makeKey('ES256', 'key-a');
    const router = jwksRouter({ 'https://idp-a.test/jwks.json': [key.publicJwk] });
    const verify = verifierFor(
      [
        {
          issuer: 'https://idp-a.test',
          jwksUri: 'https://idp-a.test/jwks.json',
          audiences: ['n8n'],
          algorithms: ['ES256'],
        },
      ],
      router.fetch,
    );

    const token = await signToken(key, {
      issuer: 'https://idp-a.test',
      audience: 'n8n',
      subject: 'user-123',
      claims: { email: 'person@idp-a.test', name: 'A Person', groups: ['ops', 'eng'] },
    });

    await expect(verify(token)).resolves.toMatchObject({
      issuer: 'https://idp-a.test',
      subject: 'user-123',
      identity: 'person@idp-a.test',
      email: 'person@idp-a.test',
      name: 'A Person',
      groups: ['ops', 'eng'],
    });
  });

  it('rejects an issuer that is not allow-listed without fetching its JWKS', async () => {
    const allowed = await makeKey('ES256', 'key-a');
    const rogue = await makeKey('ES256', 'key-rogue');
    const router = jwksRouter({ 'https://idp-a.test/jwks.json': [allowed.publicJwk] });
    const verify = verifierFor(
      [
        {
          issuer: 'https://idp-a.test',
          jwksUri: 'https://idp-a.test/jwks.json',
          algorithms: ['ES256'],
        },
      ],
      router.fetch,
    );

    const token = await signToken(rogue, {
      issuer: 'https://evil.test',
      claims: { email: 'attacker@evil.test' },
    });

    await expect(verify(token)).rejects.toThrow(/not allow-listed/i);
    expect(router.calls).toHaveLength(0);
  });

  it('selects the matching issuer in a multi-issuer registry', async () => {
    const keyA = await makeKey('ES256', 'key-a');
    const keyB = await makeKey('ES256', 'key-b');
    const router = jwksRouter({
      'https://idp-a.test/jwks.json': [keyA.publicJwk],
      'https://idp-b.test/jwks.json': [keyB.publicJwk],
    });
    const verify = verifierFor(
      [
        {
          issuer: 'https://idp-a.test',
          jwksUri: 'https://idp-a.test/jwks.json',
          algorithms: ['ES256'],
        },
        {
          issuer: 'https://idp-b.test',
          jwksUri: 'https://idp-b.test/jwks.json',
          algorithms: ['ES256'],
        },
      ],
      router.fetch,
    );

    const tokenA = await signToken(keyA, {
      issuer: 'https://idp-a.test',
      claims: { email: 'a@idp-a.test' },
    });
    const tokenB = await signToken(keyB, {
      issuer: 'https://idp-b.test',
      claims: { email: 'b@idp-b.test' },
    });
    await expect(verify(tokenA)).resolves.toMatchObject({ identity: 'a@idp-a.test' });
    await expect(verify(tokenB)).resolves.toMatchObject({ identity: 'b@idp-b.test' });

    // A token claiming issuer A but signed with issuer B's key must not verify.
    const spoofed = await signToken(keyB, {
      issuer: 'https://idp-a.test',
      claims: { email: 'a@idp-a.test' },
    });
    await expect(verify(spoofed)).rejects.toThrow();
  });

  it('rejects a token whose audience does not match', async () => {
    const key = await makeKey('ES256', 'key-a');
    const router = jwksRouter({ 'https://idp-a.test/jwks.json': [key.publicJwk] });
    const verify = verifierFor(
      [
        {
          issuer: 'https://idp-a.test',
          jwksUri: 'https://idp-a.test/jwks.json',
          audiences: ['n8n'],
          algorithms: ['ES256'],
        },
      ],
      router.fetch,
    );

    const token = await signToken(key, {
      issuer: 'https://idp-a.test',
      audience: 'some-other-app',
      claims: { email: 'person@idp-a.test' },
    });

    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const key = await makeKey('ES256', 'key-a');
    const router = jwksRouter({ 'https://idp-a.test/jwks.json': [key.publicJwk] });
    const verify = verifierFor(
      [
        {
          issuer: 'https://idp-a.test',
          jwksUri: 'https://idp-a.test/jwks.json',
          algorithms: ['ES256'],
        },
      ],
      router.fetch,
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const token = await signToken(key, {
      issuer: 'https://idp-a.test',
      issuedAt: nowSec - 7200,
      expiresAt: nowSec - 3600,
      claims: { email: 'person@idp-a.test' },
    });

    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects a token signed with a non-pinned algorithm', async () => {
    const rsaKey = await makeKey('RS256', 'key-rsa');
    const router = jwksRouter({ 'https://idp-a.test/jwks.json': [rsaKey.publicJwk] });
    const verify = verifierFor(
      // Issuer pins ES256; the token is a valid RS256 signature over an allow-listed issuer.
      [
        {
          issuer: 'https://idp-a.test',
          jwksUri: 'https://idp-a.test/jwks.json',
          algorithms: ['ES256'],
        },
      ],
      router.fetch,
    );

    const token = await signToken(rsaKey, {
      issuer: 'https://idp-a.test',
      claims: { email: 'person@idp-a.test' },
    });

    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects a token missing the configured identity claim', async () => {
    const key = await makeKey('ES256', 'key-a');
    const router = jwksRouter({ 'https://idp-a.test/jwks.json': [key.publicJwk] });
    const verify = verifierFor(
      [
        {
          issuer: 'https://idp-a.test',
          jwksUri: 'https://idp-a.test/jwks.json',
          algorithms: ['ES256'],
          identityClaim: 'email',
        },
      ],
      router.fetch,
    );

    const token = await signToken(key, {
      issuer: 'https://idp-a.test',
      claims: { name: 'No Email' },
    });
    await expect(verify(token)).rejects.toThrow(/identity claim 'email'/i);
  });

  it('enforces requiredGroups when configured', async () => {
    const key = await makeKey('ES256', 'key-a');
    const router = jwksRouter({ 'https://idp-a.test/jwks.json': [key.publicJwk] });
    const verify = verifierFor(
      [
        {
          issuer: 'https://idp-a.test',
          jwksUri: 'https://idp-a.test/jwks.json',
          algorithms: ['ES256'],
          requiredGroups: ['admins'],
        },
      ],
      router.fetch,
    );

    const denied = await signToken(key, {
      issuer: 'https://idp-a.test',
      claims: { email: 'person@idp-a.test', groups: ['users'] },
    });
    await expect(verify(denied)).rejects.toThrow(/required groups/i);

    const allowed = await signToken(key, {
      issuer: 'https://idp-a.test',
      claims: { email: 'person@idp-a.test', groups: ['users', 'admins'] },
    });
    await expect(verify(allowed)).resolves.toMatchObject({ groups: ['users', 'admins'] });
  });

  it('throws when constructed with an empty issuer registry', () => {
    expect(() => createIdentityVerifier({ issuers: [] })).toThrow(/at least one trusted issuer/i);
  });
});

describe('selectToken', () => {
  it('returns the first present source header, in order', () => {
    const token = selectToken(
      { 'x-proxy-jwt-assertion': 'assertion-token', 'x-forwarded-access-token': 'other' },
      ['x-proxy-jwt-assertion', 'x-forwarded-access-token'],
    );
    expect(token).toBe('assertion-token');
  });

  it('falls through empty headers to the next candidate', () => {
    const token = selectToken(
      { 'x-proxy-jwt-assertion': '', 'x-forwarded-access-token': 'fwd-token' },
      ['x-proxy-jwt-assertion', 'x-forwarded-access-token'],
    );
    expect(token).toBe('fwd-token');
  });

  it('strips the Bearer prefix from the authorization header', () => {
    expect(selectToken({ authorization: 'Bearer abc.def.ghi' }, ['authorization'])).toBe(
      'abc.def.ghi',
    );
  });

  it('ignores a non-Bearer authorization header', () => {
    expect(selectToken({ authorization: 'Basic dXNlcjpwYXNz' }, ['authorization'])).toBeUndefined();
  });

  it('uses the first value of an array-valued header', () => {
    expect(
      selectToken({ 'x-proxy-jwt-assertion': ['first', 'second'] }, ['x-proxy-jwt-assertion']),
    ).toBe('first');
  });

  it('returns undefined when no source header is present', () => {
    expect(selectToken({}, ['x-proxy-jwt-assertion', 'authorization'])).toBeUndefined();
  });
});

type KeyMaterial = Awaited<ReturnType<typeof makeKey>>;

async function makeKey(alg: 'ES256' | 'RS256', kid: string) {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = alg;
  publicJwk.use = 'sig';

  return { kid, alg, privateKey, publicJwk };
}

interface SignOptions {
  issuer: string;
  audience?: string;
  subject?: string;
  claims?: JWTPayload;
  issuedAt?: number;
  expiresAt?: number | string;
}

async function signToken(key: KeyMaterial, options: SignOptions): Promise<string> {
  const jwt = new SignJWT(options.claims ?? {})
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer(options.issuer)
    .setSubject(options.subject ?? 'subject-1')
    .setIssuedAt(options.issuedAt)
    .setExpirationTime(options.expiresAt ?? '5m');

  if (options.audience !== undefined) {
    jwt.setAudience(options.audience);
  }

  return jwt.sign(key.privateKey);
}

function verifierFor(issuers: TrustedIssuer[], fetch: FetchImplementation) {
  return createIdentityVerifier({
    issuers: issuers.map((issuer) => ({ ...issuer, remoteJwks: { [customFetch]: fetch } })),
  });
}

function jwksRouter(routes: Record<string, JWK[]>): {
  fetch: FetchImplementation;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: FetchImplementation = (url) => {
    const href = url;
    calls.push(href);
    const keys = routes[href];
    if (keys === undefined) {
      return Promise.resolve(
        new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  return { fetch, calls };
}
