/**
 * Mint a single valid trusted-issuer JWT and print it to stdout. Used by scripts/e2e.sh
 * for the S12 boot-survival check, where a one-off token is needed outside the vitest
 * driver. Reads the same generated private key as the scenario spec.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importJWK, SignJWT, type JWK } from 'jose';

import { TEST_ALGORITHM, TEST_AUDIENCE, TEST_ISSUER } from './constants.js';

interface GeneratedKeys {
  trusted: { kid: string; privateJwk: JWK };
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const keys = JSON.parse(
    readFileSync(resolve(root, 'e2e/.generated-keys.json'), 'utf8'),
  ) as GeneratedKeys;
  const key = await importJWK(keys.trusted.privateJwk, TEST_ALGORITHM);
  const token = await new SignJWT({ email: 's12-user@e2e.test' })
    .setProtectedHeader({ alg: TEST_ALGORITHM, kid: keys.trusted.kid })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject('s12-sub')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
  process.stdout.write(token);
}

void main();
