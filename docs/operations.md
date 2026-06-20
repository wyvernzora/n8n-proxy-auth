# Operations

## Publishing the patched image to GHCR

The [`build-test-publish`](../.github/workflows/build-test-publish.yml) workflow publishes the
patched n8n image to GitHub Container Registry on every push to `main` (and via
`workflow_dispatch`). Pull requests only run the `e2e` gate — they never publish.

- **Image:** `ghcr.io/<owner>/n8n-proxy-auth`, tagged with the upstream version read from the
  Dockerfile `ARG N8N_VERSION` plus `:latest`. That ARG is the single source of truth for the
  version, shared with Renovate (see P3).
- **Auth:** the workflow uses the built-in `GITHUB_TOKEN` with `packages: write` — no PAT needed.
- **First publish:** the initial push to `main` creates the package. Afterward, in the package
  settings you can set its visibility (Package settings → Change visibility) and link it to this
  repo (Package settings → Connect repository). Use the lowercase `owner/repo` path for any manual
  pulls (`docker pull ghcr.io/<owner>/n8n-proxy-auth:<version>`).
- **Pre-flight:** `workflow_dispatch` runs the same publish path as a push to `main`, so you can
  exercise the GHCR auth + multi-arch build + attestation wiring once before relying on the push
  trigger.

## Branch protection (the required check)

`main` **must** require the status check named **`e2e`** — the gate job in `build-test-publish`.
With Renovate's `platformAutomerge`, this required check is the **only** interlock that stops a
broken upstream bump from auto-merging and publishing (see [design §10](./design.md)). GitHub will
otherwise merge a green-less PR.

- The check name is the literal string **`e2e`** (the workflow job's `id` and `name` are both
  `e2e`). If that job is ever renamed, update this doc **and** the branch-protection rule together —
  a missing/renamed required check silently defeats the interlock.
- Branch protection lives in GitHub repo settings, not in this repo, so it must be configured once
  by hand: Settings → Branches → add a rule for `main` → "Require status checks to pass" → select
  `e2e`.

## Automated upstream tracking (Renovate)

[`renovate.json`](../renovate.json) keeps the patched image moving with upstream n8n, hands-off:

- **What it tracks:** Renovate's `dockerfile` manager bumps the `ARG N8N_VERSION` line in the
  Dockerfile (image stays in `FROM`, version in `ARG`). `pinDigests` also pins/refreshes the base
  image digest; digest-bump PRs flow through the same gate.
- **Channel:** `versioning: semver` + `allowedVersions: /^\d+\.\d+\.\d+$/` follows only stable
  releases — it excludes `next`, `beta`, `latest`, and `2.x.y-<sha>` tags.
- **Auto-merge:** `automerge` + `platformAutomerge` let a bump merge **only** once the required
  `e2e` check is green. A bad upstream bump fails e2e and parks as a red PR instead of publishing —
  this is the auto-update interlock from [design §10](./design.md). It depends entirely on the
  branch-protection rule above; without the required `e2e` check, GitHub could merge a bump with no
  passing tests.
- **Hosting:** the Mend-hosted Renovate GitHub App (decision D5) — install it on the repo; no
  self-hosted runner needed. Auto-merge behavior is identical either way.
