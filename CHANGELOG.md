# Changelog

## v0.1.0

Initial release.

- Ship the proxy-auth external hook as a bundled CommonJS artifact.
- Publish release artifacts as both `n8n-proxy-auth-hook-v0.1.0.tar.gz` and
  `ghcr.io/<owner>/n8n-proxy-auth-hook:v0.1.0`.
- Support official n8n deployments by mounting the hook with `EXTERNAL_HOOK_FILES`.
- Include mock-JWKS e2e coverage and optional real-Pomerium smoke coverage.
