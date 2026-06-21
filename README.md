# n8n-proxy-auth

Run upstream [n8n](https://n8n.io) behind Pomerium or another JWKS-backed
identity-aware proxy, with the proxy as the login layer.

This project ships one external hook for upstream n8n. The hook verifies a proxy-signed JWT, maps
the verified email to an n8n user, and issues a native `n8n-auth` cookie through n8n's own
`AuthService`.

## Deploy

Use the official n8n distribution and provide the hook as a separate pinned artifact.

Release artifacts:

```text
ghcr.io/<owner>/n8n-proxy-auth-hook:v0.1.0
n8n-proxy-auth-hook-v0.1.0.tar.gz
```

The OCI image is a one-shot installer. It copies `/hook.cjs` to `/out/hook.cjs` by default. The
tarball contains the same `hook.cjs` file for non-container installs.

### Standalone n8n

```sh
curl -fsSLO https://github.com/<owner>/n8n-proxy-auth/releases/download/v0.1.0/n8n-proxy-auth-hook-v0.1.0.tar.gz
tar -xzf n8n-proxy-auth-hook-v0.1.0.tar.gz -C /opt
```

Set:

```sh
EXTERNAL_HOOK_FILES=/opt/n8n-proxy-auth-hook/hook.cjs
```

### Docker

Populate a named volume from the hook image, then mount it into the official n8n container:

```sh
docker volume create n8n-proxy-auth-hook
docker run --rm -v n8n-proxy-auth-hook:/out ghcr.io/<owner>/n8n-proxy-auth-hook:v0.1.0

docker run -d --name n8n \
  -v n8n-proxy-auth-hook:/opt/proxy-auth:ro \
  -e EXTERNAL_HOOK_FILES=/opt/proxy-auth/hook.cjs \
  -e N8N_PROXY_AUTH_JWKS_URL="https://n8n.example.com/.well-known/pomerium/jwks.json" \
  -e N8N_PROXY_AUTH_ISSUER="n8n.example.com" \
  -e N8N_PROXY_AUTH_AUDIENCE="n8n.example.com" \
  -e N8N_USER_MANAGEMENT_JWT_SECRET="<stable long random secret>" \
  -e N8N_HOST="n8n.example.com" \
  -e N8N_PROXY_HOPS=1 \
  n8nio/n8n:<n8n-version>
```

### Kubernetes

Use the hook image as an init container and mount the populated `emptyDir` into official n8n:

```yaml
volumes:
  - name: proxy-auth-hook
    emptyDir: {}

initContainers:
  - name: install-proxy-auth-hook
    image: ghcr.io/<owner>/n8n-proxy-auth-hook:v0.1.0
    volumeMounts:
      - name: proxy-auth-hook
        mountPath: /out

containers:
  - name: n8n
    image: n8nio/n8n:<n8n-version>
    env:
      - name: EXTERNAL_HOOK_FILES
        value: /opt/proxy-auth/hook.cjs
      - name: N8N_PROXY_AUTH_JWKS_URL
        value: https://n8n.example.com/.well-known/pomerium/jwks.json
      - name: N8N_PROXY_AUTH_ISSUER
        value: n8n.example.com
      - name: N8N_PROXY_AUTH_AUDIENCE
        value: n8n.example.com
    volumeMounts:
      - name: proxy-auth-hook
        mountPath: /opt/proxy-auth
        readOnly: true
```

### Put n8n behind the proxy

Keep the n8n container reachable only from the proxy. Do not expose it directly to users.

For Pomerium, the route should inject `x-pomerium-jwt-assertion`. Do not add a route-level
`remove_request_headers: [x-pomerium-jwt-assertion]`; Pomerium overwrites client-supplied copies on
ingress, and a route strip can remove Pomerium's own signed assertion before it reaches n8n.

### Configure n8n

With Pomerium's default `jwt_issuer_format: IssuerHostOnly`, the assertion `iss` and `aud` are the
bare route host, with no scheme or trailing slash. Confirm the exact values from a live token if
your route differs:

```sh
curl -fsS https://n8n.example.com/.pomerium/jwt
```

Decode the JWT and copy the literal `iss`, `aud`, and algorithm into the env above.

### Complete first-run owner setup

n8n still requires the one-time owner setup. Complete that normally through n8n after the proxy is in
front of it. After the owner exists, proxy-authenticated users are just-in-time provisioned as
`global:member`.

The hook never makes the first proxy user the owner.

## Configuration

All hook configuration uses `N8N_PROXY_AUTH_*`.

| Env var                              | Default                                                                                                                             | Meaning                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `N8N_PROXY_AUTH_JWKS_URL`            | required                                                                                                                            | JWKS URI for the issuer                                                                       |
| `N8N_PROXY_AUTH_ISSUER`              | required                                                                                                                            | Exact `iss` allow-list entry                                                                  |
| `N8N_PROXY_AUTH_AUDIENCE`            | required                                                                                                                            | Accepted `aud` value, comma-separated                                                         |
| `N8N_PROXY_AUTH_ALGORITHMS`          | `ES256`                                                                                                                             | Pinned algorithm allow-list; `HS*` is rejected                                                |
| `N8N_PROXY_AUTH_HEADER`              | `x-pomerium-jwt-assertion`, then `authorization`, `x-forwarded-access-token`, `x-auth-request-access-token`, `x-forwarded-id-token` | Source headers in precedence order; `authorization` is parsed as `Bearer`                     |
| `N8N_PROXY_AUTH_EMAIL_CLAIM`         | `email`                                                                                                                             | Claim required by the issuer preset. n8n account lookup still uses the verified `email` claim |
| `N8N_PROXY_AUTH_AUTO_PROVISION`      | `true`                                                                                                                              | Create unknown users as `global:member`; set `false` to require existing users                |
| `N8N_PROXY_AUTH_CLOCK_TOLERANCE_SEC` | `60`                                                                                                                                | Clock skew tolerance for JWT time claims                                                      |
| `N8N_PROXY_AUTH_ISSUERS`             | unset                                                                                                                               | Advanced: path to a JSON `TrustedIssuer[]`; overrides the simple single-issuer env vars       |

Any config error disables the hook and leaves n8n running without proxy auth. Check container logs
for `[n8n-proxy-auth]`.

## Security Notes

- The hook verifies a signed JWT against a configured JWKS; it does not trust a plaintext email
  header.
- n8n must still be reachable only through the proxy. A stolen valid assertion can be replayed until
  it expires.
- The verifier exact-matches `iss`, requires a non-empty audience, and pins algorithms.
- Access control belongs in the proxy policy. This project does not maintain an n8n-side allow-list.
- Local n8n logout is not the real logout boundary; while the proxy session is still valid, the next
  request can re-issue an n8n cookie.

## Maintain

Useful commands:

```sh
corepack pnpm run check
./scripts/e2e.sh n8n-proxy-auth-hook:test
./scripts/e2e.pomerium.sh n8n-proxy-auth-hook:test
```

Further maintenance docs:

- [Architecture](docs/architecture.md) - hook design, n8n internal couplings, security invariants.
- [Maintenance](docs/maintenance.md) - local development, CI, publishing, Renovate, e2e smoke tests.

## License

See [LICENSE](LICENSE).
