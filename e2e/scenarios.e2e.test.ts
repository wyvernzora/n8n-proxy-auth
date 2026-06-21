/**
 * The executable spec. The host driver plays an identity-aware proxy: it mints ES256 JWTs
 * with the trusted private key and drives n8n over HTTP. Every scenario
 * probes a single endpoint (PROBE_PATH) so 200-with-expected-email vs 401 is the one
 * discriminator; the splice-installed signal is the dedicated probe route.
 *
 * Run ONLY by scripts/e2e.sh (vitest.e2e.config.ts), after the harness has built the
 * hook image, brought up compose, and seeded the owner. Authoring is red-first: SSO scenarios
 * fail on bare n8n; rejection scenarios pass even on bare n8n.
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importJWK, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DRIVER_USER_AGENT,
  INSTALL_PROBE_PATH,
  N8N_BASE_URL,
  N8N_PORT,
  PROBE_PATH,
  TEST_ALGORITHM,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TRUSTED_HEADER,
  UNPINNED_ALGORITHM,
  WRONG_AUDIENCE,
  WRONG_ISSUER,
} from './constants.js';

/** jose 6 has no exported `KeyLike`; derive the imported-key type from the API. */
type SigningKey = Awaited<ReturnType<typeof importJWK>>;

interface GeneratedKeys {
  trusted: { kid: string; privateJwk: JWK };
  rogue: { kid: string; privateJwk: JWK };
  unpinnedAlg: { kid: string; privateJwk: JWK };
}

let trustedKey: SigningKey;
let trustedKid: string;
let rogueKey: SigningKey;
let rogueKid: string;
let unpinnedAlgKey: SigningKey;
let unpinnedAlgKid: string;

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

beforeAll(async () => {
  const raw = readFileSync(resolve(repoRoot(), 'e2e/.generated-keys.json'), 'utf8');
  const keys = JSON.parse(raw) as GeneratedKeys;
  trustedKid = keys.trusted.kid;
  rogueKid = keys.rogue.kid;
  unpinnedAlgKid = keys.unpinnedAlg.kid;
  trustedKey = await importJWK(keys.trusted.privateJwk, TEST_ALGORITHM);
  rogueKey = await importJWK(keys.rogue.privateJwk, TEST_ALGORITHM);
  unpinnedAlgKey = await importJWK(keys.unpinnedAlg.privateJwk, UNPINNED_ALGORITHM);
});

// ---------------------------------------------------------------------------
// token minting
// ---------------------------------------------------------------------------

interface MintOptions {
  email?: string;
  name?: string;
  issuer?: string;
  audience?: string;
  subject?: string;
  algKid?: { key: SigningKey; kid: string; alg?: string };
  expiresAt?: number | string;
  issuedAt?: number;
  omitEmail?: boolean;
}

async function mint(options: MintOptions = {}): Promise<string> {
  const signer = options.algKid ?? { key: trustedKey, kid: trustedKid, alg: TEST_ALGORITHM };
  const claims: Record<string, unknown> = {};
  if (!options.omitEmail) {
    claims.email = options.email ?? 'user@e2e.test';
  }
  if (options.name !== undefined) {
    claims.name = options.name;
  }
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: signer.alg ?? TEST_ALGORITHM, kid: signer.kid })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setSubject(options.subject ?? 'sub-1')
    .setIssuedAt(options.issuedAt)
    .setExpirationTime(options.expiresAt ?? '5m');
  return jwt.sign(signer.key);
}

// ---------------------------------------------------------------------------
// HTTP driver
// ---------------------------------------------------------------------------

interface DriveOptions {
  token?: string | undefined;
  cookie?: string | undefined;
  path?: string | undefined;
}

interface DriveResult {
  status: number;
  setCookie: string[];
  body: string;
}

function extractSetCookie(res: Response): string[] {
  // Node 24 fetch exposes getSetCookie().
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single === null ? [] : [single];
}

async function drive(options: DriveOptions = {}): Promise<DriveResult> {
  const headers: [string, string][] = [['user-agent', DRIVER_USER_AGENT]];
  if (options.token !== undefined) {
    headers.push([TRUSTED_HEADER, options.token]);
  }
  if (options.cookie !== undefined) {
    headers.push(['cookie', options.cookie]);
  }
  const res = await fetch(`${N8N_BASE_URL}${options.path ?? PROBE_PATH}`, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });
  const body = await res.text();
  return { status: res.status, setCookie: extractSetCookie(res), body };
}

/**
 * Raw-socket HTTP/1.1 GET that emits each provided header line LITERALLY and SEPARATELY,
 * bypassing fetch/undici (which would merge duplicate same-name header tuples into one
 * comma-joined line CLIENT-SIDE before transmission). This is the only way to put two
 * literal trusted-header lines on the wire so the RECEIVING n8n Node server
 * performs the duplicate-header merge — the locked wire mechanism under test.
 */
async function driveRaw(path: string, headerLines: string[]): Promise<DriveResult> {
  const rawResponse = await new Promise<string>((resolveRaw, rejectRaw) => {
    const socket = connect({ host: 'localhost', port: N8N_PORT }, () => {
      const request =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: localhost:${String(N8N_PORT)}\r\n` +
        headerLines.map((line) => `${line}\r\n`).join('') +
        `Connection: close\r\n\r\n`;
      socket.write(request);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      resolveRaw(Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('error', rejectRaw);
  });

  const headerEnd = rawResponse.indexOf('\r\n\r\n');
  const headerBlock = headerEnd >= 0 ? rawResponse.slice(0, headerEnd) : rawResponse;
  const body = headerEnd >= 0 ? rawResponse.slice(headerEnd + 4) : '';
  const lines = headerBlock.split('\r\n');
  const statusLine = lines[0] ?? '';
  const status = Number(statusLine.split(' ')[1] ?? '0');
  const setCookie = lines
    .filter((line) => /^set-cookie:/i.test(line))
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
  return { status, setCookie, body };
}

function authCookieFrom(setCookie: string[]): string | undefined {
  for (const entry of setCookie) {
    if (entry.startsWith('n8n-auth=')) {
      const value = entry.slice('n8n-auth='.length).split(';')[0];
      if (value !== undefined && value.length > 0) {
        return `n8n-auth=${value}`;
      }
    }
  }
  return undefined;
}

function hasAuthCookie(setCookie: string[]): boolean {
  return authCookieFrom(setCookie) !== undefined;
}

function emailFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { data?: { email?: string } };
    return parsed.data?.email;
  } catch {
    return undefined;
  }
}

/**
 * n8n's PublicUser serializes `role` as a plain SLUG STRING (userService.toPublic
 * returns `role: role?.slug`), not an object. Read it as a string; defensively fall
 * back to a `.slug` shape so a future serialization change does not silently break.
 */
function roleSlugFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { data?: { role?: string | { slug?: string } } };
    const role = parsed.data?.role;
    if (typeof role === 'string') {
      return role;
    }
    return role?.slug;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('splice installed', () => {
  it('registers the unauthenticated probe route on the default service (scenario 1 prerequisite)', async () => {
    const res = await drive({ path: INSTALL_PROBE_PATH });
    expect(res.status).toBe(204);
  });
});

describe('scenario 1 — valid assertion, unknown user', () => {
  it('issues n8n-auth AND authenticates the same request', async () => {
    const token = await mint({ email: 's1-user@e2e.test', name: 'Scenario One' });
    const res = await drive({ token });
    expect(hasAuthCookie(res.setCookie)).toBe(true);
    expect(res.status).toBe(200);
    expect(emailFromBody(res.body)).toBe('s1-user@e2e.test');
    // JIT-provisioned AS A MEMBER, never owner (design D3 / phase constraint 3).
    expect(roleSlugFromBody(res.body)).toBe('global:member');
  });
});

describe('scenario 2 — cookie-only authenticates a follow-up request', () => {
  it('a cookie minted with browserId undefined authenticates with no header and no browser-id', async () => {
    const token = await mint({ email: 's2-user@e2e.test' });
    const first = await drive({ token });
    const cookie = authCookieFrom(first.setCookie);
    expect(cookie).toBeDefined();

    const second = await drive({ cookie });
    expect(second.status).toBe(200);
    expect(emailFromBody(second.body)).toBe('s2-user@e2e.test');
  });
});

describe('scenario 3 — JIT provision + reuse', () => {
  it('provisions on first login and reuses the same user on the second', async () => {
    const email = 's3-user@e2e.test';
    const first = await drive({ token: await mint({ email }) });
    expect(first.status).toBe(200);
    expect(emailFromBody(first.body)).toBe(email);
    // Provisioned AS A MEMBER, explicitly NOT owner (design D3 / phase constraint 3).
    expect(roleSlugFromBody(first.body)).toBe('global:member');
    expect(roleSlugFromBody(first.body)).not.toBe('global:owner');

    const second = await drive({ token: await mint({ email }) });
    expect(second.status).toBe(200);
    expect(hasAuthCookie(second.setCookie)).toBe(true);
    expect(emailFromBody(second.body)).toBe(email);
    // Found-user path loads the role relation: still a member on reuse.
    expect(roleSlugFromBody(second.body)).toBe('global:member');
  });
});

describe('scenario 4 — no header, no cookie', () => {
  it('is unauthenticated (401) — passes even on bare n8n', async () => {
    const res = await drive();
    expect(res.status).toBe(401);
    expect(hasAuthCookie(res.setCookie)).toBe(false);
  });
});

describe('scenario 5 — parameterized rejections', () => {
  it('rejects an invalid (garbage) token', async () => {
    const res = await drive({ token: 'not.a.valid.jwt' });
    expect(hasAuthCookie(res.setCookie)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await mint({ issuedAt: nowSec - 7200, expiresAt: nowSec - 3600 });
    const res = await drive({ token });
    expect(hasAuthCookie(res.setCookie)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong-issuer token', async () => {
    const token = await mint({ issuer: WRONG_ISSUER });
    const res = await drive({ token });
    expect(hasAuthCookie(res.setCookie)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong-audience token', async () => {
    const token = await mint({ audience: WRONG_AUDIENCE });
    const res = await drive({ token });
    expect(hasAuthCookie(res.setCookie)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('rejects an unpinned-algorithm token', async () => {
    // Faithful alg-pin attribution: the token is signed with RS256 by a key whose PUBLIC
    // half IS in the mock JWKS and carries the correct trusted iss/aud — so signature, iss,
    // and aud all verify. The ONLY thing wrong is the algorithm: RS256 is not in the pinned
    // ES256 allow-list. The rejection is therefore attributable to algorithm pinning, the
    // mechanism that defeats alg:none and RS256→HS256 confusion.
    const token = await mint({
      algKid: { key: unpinnedAlgKey, kid: unpinnedAlgKid, alg: UNPINNED_ALGORITHM },
    });
    const res = await drive({ token });
    expect(hasAuthCookie(res.setCookie)).toBe(false);
    expect(res.status).toBe(401);
  });
});

describe('scenario 6 — non-allow-listed issuer', () => {
  it('rejects a token validly signed by a key not in the allow-list', async () => {
    // The rogue key is absent from the mock JWKS AND its issuer is not allow-listed.
    const token = await mint({
      issuer: WRONG_ISSUER,
      algKid: { key: rogueKey, kid: rogueKid },
    });
    const res = await drive({ token });
    expect(hasAuthCookie(res.setCookie)).toBe(false);
    expect(res.status).toBe(401);
  });
});

describe('reconcile (design D6)', () => {
  it('case A — cookie for user A + header for user B re-issues for B', async () => {
    const cookieA = authCookieFrom(
      (await drive({ token: await mint({ email: 'recon-a@e2e.test' }) })).setCookie,
    );
    expect(cookieA).toBeDefined();

    const res = await drive({ token: await mint({ email: 'recon-b@e2e.test' }), cookie: cookieA });
    expect(hasAuthCookie(res.setCookie)).toBe(true);
    expect(res.status).toBe(200);
    expect(emailFromBody(res.body)).toBe('recon-b@e2e.test');
  });

  it('case B — wrong-signature cookie + valid header re-issues for the header identity', async () => {
    const bogusCookie = 'n8n-auth=eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImZvbyJ9.invalidsignature';
    const res = await drive({
      token: await mint({ email: 'recon-c@e2e.test' }),
      cookie: bogusCookie,
    });
    expect(hasAuthCookie(res.setCookie)).toBe(true);
    expect(res.status).toBe(200);
    expect(emailFromBody(res.body)).toBe('recon-c@e2e.test');
  });

  it('case C — cookie + matching header passes through without an identity switch', async () => {
    const email = 'recon-same@e2e.test';
    const cookie = authCookieFrom((await drive({ token: await mint({ email }) })).setCookie);
    expect(cookie).toBeDefined();

    const res = await drive({ token: await mint({ email }), cookie });
    expect(res.status).toBe(200);
    // The hook MUST NOT re-issue for a different identity. We do NOT assert the absence of
    // any Set-Cookie, because n8n's OWN per-route auth may refresh the n8n-auth cookie within
    // its refresh window — an n8n internal the hook does not control. The robust signal is
    // that the authenticated identity did not switch: whatever cookie is in play still
    // resolves to the SAME email. (A hook over-issue for a different identity would surface
    // as a different email here.)
    expect(emailFromBody(res.body)).toBe(email);
  });
});

describe('header-verified-first invariant', () => {
  it('invalid header + valid cookie → no re-issue, authenticates as the cookie identity', async () => {
    const email = 'hvf-user@e2e.test';
    const cookie = authCookieFrom((await drive({ token: await mint({ email }) })).setCookie);
    expect(cookie).toBeDefined();

    const res = await drive({ token: 'garbage.header.value', cookie });
    expect(res.status).toBe(200);
    // The invalid header never verifies, so the hook falls through; n8n's own cookie auth
    // answers as the cookie identity. As in reconcile case C we assert on the identity rather
    // than the absence of a Set-Cookie (n8n may self-refresh the cookie, which the hook does
    // not control): the authenticated email must remain the cookie identity, never switch.
    expect(emailFromBody(res.body)).toBe(email); // n8n's own cookie auth answered
  });
});

describe('duplicate trusted header fails closed', () => {
  it('two literal header lines are merged server-side into a comma-joined string that breaks decodeJwt', async () => {
    // Two literal trusted-header lines are written to the wire via a raw socket.
    // The RECEIVING n8n Node server merges duplicate header lines into one comma-joined string
    // (`TOK, TOK`), which is not a valid compact JWS → Layer-1 decodeJwt throws → fail closed.
    const token = await mint({ email: 'dup-user@e2e.test' });
    const res = await driveRaw(PROBE_PATH, [
      `user-agent: ${DRIVER_USER_AGENT}`,
      `${TRUSTED_HEADER}: ${token}`,
      `${TRUSTED_HEADER}: ${token}`,
    ]);
    expect(hasAuthCookie(res.setCookie)).toBe(false);
    expect(res.status).toBe(401);
  });
});

describe('identity key = normalized email', () => {
  it('reuses the same account for an email differing only by case/whitespace', async () => {
    const first = await drive({ token: await mint({ email: 'Norm.User@E2E.test' }) });
    expect(first.status).toBe(200);
    expect(emailFromBody(first.body)).toBe('norm.user@e2e.test');

    const second = await drive({ token: await mint({ email: '  norm.user@e2e.test  ' }) });
    expect(second.status).toBe(200);
    expect(emailFromBody(second.body)).toBe('norm.user@e2e.test');
  });

  it('rejects a signature-verified token with no email claim (present-vs-absent)', async () => {
    const token = await mint({ omitEmail: true });
    const res = await drive({ token });
    expect(hasAuthCookie(res.setCookie)).toBe(false);
    expect(res.status).toBe(401);
  });
});
