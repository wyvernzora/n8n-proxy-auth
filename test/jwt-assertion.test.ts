import {
  customFetch,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type FetchImplementation,
  type JWK,
} from 'jose';
import { describe, expect, it } from 'vitest';

import { createJwtAssertionVerifier } from '../src/jwt-assertion.js';

describe('createJwtAssertionVerifier', () => {
  it('validates a JWT against the configured JWKS', async () => {
    const issuer = 'https://authenticate.example.test';
    const audience = 'n8n';
    const kid = 'test-key';
    const { privateKey, publicJwk } = await createSigningKey(kid);
    const jwks = createTestJwks({ keys: [publicJwk] });
    const jwt = await new SignJWT({
      email: 'person@example.test',
      groups: ['ops', 'automation'],
      name: 'Example Person',
    })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setSubject('proxy-user-id')
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const verify = createJwtAssertionVerifier({
      audience,
      issuer,
      jwksUrl: jwks.url,
      remoteJwks: {
        [customFetch]: jwks.fetch,
      },
    });

    await expect(verify(jwt)).resolves.toMatchObject({
      email: 'person@example.test',
      groups: ['ops', 'automation'],
      name: 'Example Person',
      subject: 'proxy-user-id',
    });
  });

  it('rejects JWTs with the wrong issuer', async () => {
    const kid = 'test-key';
    const { privateKey, publicJwk } = await createSigningKey(kid);
    const jwks = createTestJwks({ keys: [publicJwk] });
    const jwt = await new SignJWT()
      .setProtectedHeader({ alg: 'ES256', kid })
      .setSubject('proxy-user-id')
      .setIssuer('https://wrong.example.test')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const verify = createJwtAssertionVerifier({
      issuer: 'https://authenticate.example.test',
      jwksUrl: jwks.url,
      remoteJwks: {
        [customFetch]: jwks.fetch,
      },
    });

    await expect(verify(jwt)).rejects.toThrow();
  });
});

async function createSigningKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.use = 'sig';

  return { privateKey, publicJwk };
}

function createTestJwks(jwks: { keys: JWK[] }) {
  const url = 'https://authenticate.example.test/.well-known/jwks.json';
  const fetch: FetchImplementation = (requestUrl) => {
    expect(requestUrl).toBe(url);

    return Promise.resolve(
      new Response(JSON.stringify(jwks), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
  };

  return { fetch, url };
}
