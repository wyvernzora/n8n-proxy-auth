# n8n Pomerium

Small patch layer for running upstream n8n behind Pomerium.

The intended shape is:

- validate Pomerium-signed JWT assertions against Pomerium's JWKS;
- map trusted Pomerium identity claims into an n8n user session;
- issue n8n-native session cookies;
- package that hook into an image derived from upstream `n8nio/n8n`;
- let CI, e2e tests, and Renovate keep the patched image moving with upstream.

This repo should stay narrow. The only product source should be the hook code under
`src/`; build, test, Docker, and release plumbing can live around it.

## Development

Corepack is used to provide pnpm:

```sh
corepack pnpm install
corepack pnpm check
```

Install the repo-local Git hooks once per checkout:

```sh
corepack pnpm hooks:install
```

The hook currently contains the Pomerium JWT verification core. The n8n session
adapter and e2e harness are the next layer.
