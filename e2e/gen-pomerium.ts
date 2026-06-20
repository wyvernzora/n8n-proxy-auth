/**
 * Generate the OPTIONAL real-Pomerium e2e secrets/TLS material fresh per run
 * (run via `tsx e2e/gen-pomerium.ts`). Mirrors e2e/gen-env.ts's structural-typing and
 * no-unsafe patterns so it stays strictTypeChecked-clean inside `corepack pnpm run check`.
 *
 * This generator is for the NON-GATING higher-fidelity smoke (P4): real Pomerium + a static
 * OIDC IdP (Dex) fronting the patched n8n image. None of this feeds the required mock-JWKS gate.
 *
 * Outputs (ALL under e2e/pomerium/.generated/, gitignored — zero secret/PEM bytes committed):
 *   - signing-key.pem        Pomerium's ES256 assertion signing key (the trust anchor whose
 *                            PUBLIC JWKS the hook trusts at /.well-known/pomerium/jwks.json)
 *   - tls-ca.pem             self-signed CA (mounted into n8n as NODE_EXTRA_CA_CERTS)
 *   - tls-cert.pem           leaf cert for Pomerium's HTTPS listener (SAN = route host)
 *   - tls-key.pem            leaf private key
 *   - secrets.env            cookie_secret + shared_secret env (referenced by compose)
 *
 * The committed e2e/pomerium/config.yaml references these BY PATH; no secret is ever inlined
 * into committed config.
 *
 * Requires `openssl` on PATH (TLS CA/leaf + the EC signing key). Pomerium derives the signing
 * JWKS from the ES256 key, so the hook's JWKS trust anchor is whatever this key produces.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEX_HOST,
  POMERIUM_AUTHENTICATE_HOST,
  POMERIUM_GENERATED_DIR,
  POMERIUM_ROUTE_HOST,
  POMERIUM_TEST_PASSWORD,
} from './pomerium-constants.js';

function repoRoot(): string {
  // This file lives at <root>/e2e/gen-pomerium.ts.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function genDir(): string {
  const abs = resolve(repoRoot(), POMERIUM_GENERATED_DIR);
  mkdirSync(abs, { recursive: true });
  return abs;
}

function openssl(args: readonly string[]): void {
  execFileSync('openssl', [...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function randomBase64(bytes: number): string {
  const out = execFileSync('openssl', ['rand', '-base64', String(bytes)]);
  return out.toString('utf8').trim();
}

function genSigningKey(dir: string): string {
  // Pomerium's assertion signing key. ES256 == NIST P-256 (prime256v1).
  const keyPath = resolve(dir, 'signing-key.pem');
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
  return keyPath;
}

function genTls(dir: string): { caPath: string; certPath: string; keyPath: string } {
  const caKey = resolve(dir, 'tls-ca-key.pem');
  const caCert = resolve(dir, 'tls-ca.pem');
  const leafKey = resolve(dir, 'tls-key.pem');
  const leafCsr = resolve(dir, 'tls-leaf.csr');
  const leafCert = resolve(dir, 'tls-cert.pem');
  const extFile = resolve(dir, 'tls-leaf.ext');

  // Self-signed CA.
  openssl(['genrsa', '-out', caKey, '2048']);
  openssl([
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-key',
    caKey,
    '-sha256',
    '-days',
    '825',
    '-subj',
    '/CN=n8n-proxy-auth-e2e-ca',
    '-out',
    caCert,
  ]);

  // Leaf key + CSR with the route host as CN.
  openssl(['genrsa', '-out', leafKey, '2048']);
  openssl(['req', '-new', '-key', leafKey, '-subj', `/CN=${POMERIUM_ROUTE_HOST}`, '-out', leafCsr]);

  // SAN ext: the route host (n8n's in-container HTTPS JWKS fetch to Pomerium), the Dex host
  // (Pomerium's OIDC discovery to Dex over HTTPS), AND the on-cluster authenticate host (the
  // sign-in redirect target). The same leaf cert backs all of these listeners, so Go's TLS
  // hostname verification needs every name present or one of the handshakes fails.
  writeFileSync(
    extFile,
    [
      'authorityKeyIdentifier=keyid,issuer',
      'basicConstraints=CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:${POMERIUM_ROUTE_HOST},DNS:${DEX_HOST},DNS:${POMERIUM_AUTHENTICATE_HOST}`,
      '',
    ].join('\n'),
    'utf8',
  );

  openssl([
    'x509',
    '-req',
    '-in',
    leafCsr,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    leafCert,
    '-days',
    '825',
    '-sha256',
    '-extfile',
    extFile,
  ]);

  return { caPath: caCert, certPath: leafCert, keyPath: leafKey };
}

function bcryptHash(password: string): string {
  // Compute a real bcrypt hash via `htpasswd` (apache2-utils; present on macOS + most Linux). This
  // guarantees the Dex credential is self-consistent rather than a hand-fabricated placeholder.
  // `-bnBC 10`: batch, no-update-file (stdout), bcrypt, cost 10. Empty username -> `:<hash>`.
  const out = execFileSync('htpasswd', ['-bnBC', '10', '', password]).toString('utf8');
  const hash = out.split(':')[1]?.trim();
  if (hash === undefined || hash.length === 0) {
    throw new Error('htpasswd produced no bcrypt hash');
  }
  return hash;
}

function genDexConfig(dir: string): string {
  // Render the committed Dex template into the generated dir with a fresh bcrypt hash so the static
  // password and its hash are guaranteed to match. The compose stack mounts THIS generated file.
  const templatePath = resolve(repoRoot(), 'e2e/oidc/dex.yaml.template');
  const outPath = resolve(dir, 'dex.yaml');
  const rendered = readFileSync(templatePath, 'utf8').replaceAll(
    '__DEX_PASSWORD_HASH__',
    bcryptHash(POMERIUM_TEST_PASSWORD),
  );
  writeFileSync(outPath, rendered, 'utf8');
  return outPath;
}

function genSecrets(dir: string): string {
  // Pomerium requires a 32-byte base64 cookie_secret and a shared_secret. Write Pomerium's CANONICAL
  // env names directly so the compose `env_file` feeds Pomerium without any `${...}` interpolation
  // (compose-file interpolation cannot read a service env_file — only the host shell / a top .env).
  const secretsPath = resolve(dir, 'secrets.env');
  const env = [
    '# GENERATED by e2e/gen-pomerium.ts — do not edit, do not commit.',
    `COOKIE_SECRET=${randomBase64(32)}`,
    `SHARED_SECRET=${randomBase64(32)}`,
    '',
  ].join('\n');
  writeFileSync(secretsPath, env, 'utf8');
  return secretsPath;
}

function main(): void {
  const dir = genDir();
  const signingKey = genSigningKey(dir);
  const tls = genTls(dir);
  const secrets = genSecrets(dir);
  const dexConfig = genDexConfig(dir);

  console.log(
    [
      `[gen-pomerium] wrote ${signingKey}`,
      `[gen-pomerium] wrote ${tls.caPath}`,
      `[gen-pomerium] wrote ${tls.certPath}`,
      `[gen-pomerium] wrote ${tls.keyPath}`,
      `[gen-pomerium] wrote ${secrets}`,
      `[gen-pomerium] wrote ${dexConfig}`,
    ].join('\n'),
  );
}

main();
