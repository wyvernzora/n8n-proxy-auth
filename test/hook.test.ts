import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hook,
  installProxyAuth,
  loadConfigFromEnv,
  makeMiddleware,
  type HookConfig,
} from '../src/proxy-auth.js';
import type { IdentityVerifier, VerifiedIdentity } from '../src/verify.js';

describe('hook export shape', () => {
  it('exposes the n8n.ready contract n8n require()s', () => {
    // Fast guard for the artifact-load contract: n8n loads the hook via require() and reads
    // `module.exports.n8n.ready[0]` as the readiness handler. The full bundling/footer-flatten
    // contract on dist/hook.cjs is covered by the isolated-dir smoke in scripts/e2e.sh.
    expect(typeof hook.n8n.ready[0]).toBe('function');
  });
});

const BASE_ENV: NodeJS.ProcessEnv = {
  N8N_PROXY_AUTH_JWKS_URL: 'https://idp.test/jwks.json',
  N8N_PROXY_AUTH_ISSUER: 'https://idp.test',
  N8N_PROXY_AUTH_AUDIENCE: 'n8n',
  N8N_PROXY_AUTH_ALGORITHMS: 'ES256',
};

describe('loadConfigFromEnv', () => {
  it('builds a single-issuer config from the simple env form', () => {
    const config = loadConfigFromEnv({ ...BASE_ENV });
    expect(config.verifierConfig.issuers).toHaveLength(1);
    const issuer = config.verifierConfig.issuers[0];
    expect(issuer?.issuer).toBe('https://idp.test');
    expect(issuer?.audiences).toEqual(['n8n']);
    expect(issuer?.algorithms).toEqual(['ES256']);
    expect(config.autoProvision).toBe(true);
  });

  it('defaults the source headers to the supported proxy header precedence order', () => {
    const config = loadConfigFromEnv({ ...BASE_ENV });
    expect(config.sourceHeaders).toEqual([
      'x-pomerium-jwt-assertion',
      'authorization',
      'x-forwarded-access-token',
      'x-auth-request-access-token',
      'x-forwarded-id-token',
    ]);
  });

  it('honors an explicit source-header override and clock tolerance', () => {
    const config = loadConfigFromEnv({
      ...BASE_ENV,
      N8N_PROXY_AUTH_HEADER: 'authorization, x-custom',
      N8N_PROXY_AUTH_CLOCK_TOLERANCE_SEC: '30',
    });
    expect(config.sourceHeaders).toEqual(['authorization', 'x-custom']);
    expect(config.verifierConfig.clockToleranceSec).toBe(30);
  });

  it('disables auto-provision when explicitly set to false', () => {
    const config = loadConfigFromEnv({ ...BASE_ENV, N8N_PROXY_AUTH_AUTO_PROVISION: 'false' });
    expect(config.autoProvision).toBe(false);
  });

  describe('audience-required (effective emptiness)', () => {
    it.each([
      ['unset', { N8N_PROXY_AUTH_AUDIENCE: undefined }],
      ['empty string', { N8N_PROXY_AUTH_AUDIENCE: '' }],
      ['whitespace only', { N8N_PROXY_AUTH_AUDIENCE: '   ' }],
      ['comma only (empty list)', { N8N_PROXY_AUTH_AUDIENCE: ',' }],
    ])('throws (SSO disabled) when audience is %s', (_label, override) => {
      expect(() => loadConfigFromEnv({ ...BASE_ENV, ...override })).toThrow(/no audience/i);
    });
  });

  describe('algorithm validation', () => {
    it('falls back to ES256 in the simple form when algorithms are blank', () => {
      const config = loadConfigFromEnv({ ...BASE_ENV, N8N_PROXY_AUTH_ALGORITHMS: ' , ' });
      expect(config.verifierConfig.issuers[0]?.algorithms).toEqual(['ES256']);
    });

    it('throws when an advanced-JSON issuer has an effectively-empty algorithm list', () => {
      const file = writeTempIssuers([
        {
          issuer: 'https://a.test',
          jwksUri: 'https://a.test/jwks.json',
          algorithms: ['  '],
          audiences: ['n8n'],
        },
      ]);
      expect(() => loadConfigFromEnv({ N8N_PROXY_AUTH_ISSUERS: file })).toThrow(/no algorithms/i);
    });

    it('rejects a symmetric HS* algorithm for a JWKS-based issuer', () => {
      expect(() => loadConfigFromEnv({ ...BASE_ENV, N8N_PROXY_AUTH_ALGORITHMS: 'HS256' })).toThrow(
        /symmetric/i,
      );
    });

    it('rejects HS* even when mixed with an asymmetric algorithm', () => {
      expect(() =>
        loadConfigFromEnv({ ...BASE_ENV, N8N_PROXY_AUTH_ALGORITHMS: 'ES256,HS256' }),
      ).toThrow(/symmetric/i);
    });
  });

  describe('advanced JSON issuer form', () => {
    it('throws when an advanced-JSON issuer has an empty audience set', () => {
      const file = writeTempIssuers([
        {
          issuer: 'https://a.test',
          jwksUri: 'https://a.test/jwks.json',
          algorithms: ['ES256'],
          audiences: [],
        },
      ]);
      expect(() => loadConfigFromEnv({ N8N_PROXY_AUTH_ISSUERS: file })).toThrow(/no audience/i);
    });

    it('throws when an advanced-JSON issuer pins HS*', () => {
      const file = writeTempIssuers([
        {
          issuer: 'https://a.test',
          jwksUri: 'https://a.test/jwks.json',
          algorithms: ['HS256'],
          audiences: ['n8n'],
        },
      ]);
      expect(() => loadConfigFromEnv({ N8N_PROXY_AUTH_ISSUERS: file })).toThrow(/symmetric/i);
    });

    it('accepts a well-formed advanced-JSON issuer', () => {
      const file = writeTempIssuers([
        {
          issuer: 'https://a.test',
          jwksUri: 'https://a.test/jwks.json',
          algorithms: ['ES256'],
          audiences: ['n8n'],
        },
      ]);
      const config = loadConfigFromEnv({ N8N_PROXY_AUTH_ISSUERS: file });
      expect(config.verifierConfig.issuers[0]?.issuer).toBe('https://a.test');
    });
  });

  it('throws when JWKS URL or issuer is missing in the simple form', () => {
    expect(() => loadConfigFromEnv({ N8N_PROXY_AUTH_AUDIENCE: 'n8n' })).toThrow(/required env/i);
  });
});

describe('installProxyAuth — boot survival', () => {
  const config: HookConfig = loadConfigFromEnv({ ...BASE_ENV });

  it('swallows a synthetic throw from stack.splice (catch block executed)', () => {
    const app = { router: { stack: makeStackWithThrowingSplice() } };
    // Must NOT throw — boot survival.
    expect(() => {
      installProxyAuth(app, config);
    }).not.toThrow();
  });

  it('returns without throwing when there is no router stack', () => {
    const app = {};
    expect(() => {
      installProxyAuth(app, config);
    }).not.toThrow();
  });

  it('skips the splice when cookieParser is absent', () => {
    const stack = [{ name: 'bodyParser', constructor: FakeLayer }];
    const app = { router: { stack } };
    installProxyAuth(app, config);
    expect(stack).toHaveLength(1);
  });

  it('splices a probe-answering middleware right after cookieParser on success', () => {
    const stack = [
      { name: 'bodyParser', constructor: FakeLayer },
      { name: 'cookieParser', constructor: FakeLayer },
      { name: 'router', constructor: FakeLayer },
    ];
    const app = { router: { stack } };
    installProxyAuth(app, config);
    expect(stack).toHaveLength(4);
    const spliced = stack[2];
    expect(spliced).toBeInstanceOf(FakeLayer);

    // The Layer MUST be built with `{ end: false }` (prefix match for ALL paths). The default
    // `end: true` would match only the exact path '/', so the middleware never runs — a silent
    // fail-open. Guard that single line here in the fast gate.
    expect((spliced as unknown as { options: { end?: boolean } }).options.end).toBe(false);

    // The spliced Layer's handler answers the probe path with 204 (the installed signal).
    const handler = (spliced as unknown as { handler: ExpressHandlerLike }).handler;
    const res = makeRes();
    let nextCalled = false;
    handler({ url: '/__proxy-auth/installed', headers: {} }, res, () => {
      nextCalled = true;
    });
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(nextCalled).toBe(false);
  });
});

describe('makeMiddleware — reconcile compare', () => {
  // A stub verifier that always returns the given identity.
  function verifierFor(identity: VerifiedIdentity): IdentityVerifier {
    return () => Promise.resolve(identity);
  }

  const config = loadConfigFromEnv({
    ...BASE_ENV,
    N8N_PROXY_AUTH_HEADER: 'x-pomerium-jwt-assertion',
  });

  it('passes through with zero side effects when no header token is present', async () => {
    const mw = makeMiddleware(config, verifierFor(makeIdentity('a@b.test')));
    const res = makeRes();
    const req = { headers: {}, cookies: {} };
    await runMiddleware(mw, req, res);
    expect(res.setCalls).toHaveLength(0);
  });

  it('passes through (unauthenticated) when the verified identity has no email', async () => {
    const identity = makeIdentity('a@b.test');
    delete identity.email;
    const mw = makeMiddleware(config, verifierFor(identity));
    const res = makeRes();
    const req = { headers: { 'x-pomerium-jwt-assertion': 'tok' }, cookies: {} };
    await runMiddleware(mw, req, res);
    expect(res.setCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeIdentity(email: string): VerifiedIdentity {
  return {
    issuer: 'https://idp.test',
    subject: 'sub-1',
    identity: email,
    email,
    groups: [],
    claims: {},
  };
}

/** A stand-in for the Express Layer constructor. */
class FakeLayer {
  constructor(
    public path: string,
    public options: unknown,
    public handler: unknown,
  ) {}
}

function makeStackWithThrowingSplice(): { name: string; constructor: unknown }[] {
  const stack: { name: string; constructor: unknown }[] = [
    { name: 'cookieParser', constructor: FakeLayer },
  ];
  // Override splice to throw, exercising the catch block.
  Object.defineProperty(stack, 'splice', {
    value: () => {
      throw new Error('synthetic splice failure');
    },
  });
  return stack;
}

type ExpressHandlerLike = (req: unknown, res: unknown, next: () => void) => void;

interface FakeRes {
  setCalls: unknown[];
  statusCode: number;
  ended: boolean;
  getHeader(name: string): string | string[] | undefined;
  end(): void;
}

function makeRes(): FakeRes {
  return {
    setCalls: [],
    statusCode: 0,
    ended: false,
    getHeader() {
      return undefined;
    },
    end() {
      this.ended = true;
    },
  };
}

type Middleware = ReturnType<typeof makeMiddleware>;

function runMiddleware(mw: Middleware, req: unknown, res: unknown): Promise<void> {
  return new Promise((resolve) => {
    mw(req as never, res as never, () => {
      resolve();
    });
  });
}

function writeTempIssuers(issuers: unknown[]): string {
  const file = join(tmpdir(), `issuers-${String(Date.now())}-${String(Math.random())}.json`);
  writeFileSync(file, JSON.stringify(issuers), 'utf8');
  return file;
}
