#!/usr/bin/env bash
#
# Hermetic e2e gate. Builds dist/hook.cjs, generates fresh keys/env, builds the hook artifact
# image, brings up compose (mock-jwks + official n8n + one-shot hook installer), seeds the owner,
# runs the scenario spec, and runs the S12 forced-skip boot-survival check on a separate run. Same
# invocation locally and in CI.
#
#   usage: scripts/e2e.sh [hook-image-tag]   (default: n8n-proxy-auth-hook:test)
set -euo pipefail

HOOK_IMAGE_TAG="${1:-n8n-proxy-auth-hook:test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/e2e/docker-compose.yml"
N8N_TEST_VERSION="${N8N_TEST_VERSION:-$(tr -d '[:space:]' < "$ROOT/e2e/n8n-version")}"
N8N_IMAGE="${N8N_IMAGE:-n8nio/n8n:$N8N_TEST_VERSION}"
BASE_URL="http://localhost:5699"
OWNER_EMAIL="owner@e2e.test"
OWNER_PASSWORD="Owner-Setup-123"

compose() {
  HOOK_IMAGE="$HOOK_IMAGE_TAG" N8N_IMAGE="$N8N_IMAGE" docker compose -f "$COMPOSE_FILE" "$@"
}

teardown() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap teardown EXIT

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Build hook + generate fixtures
# ---------------------------------------------------------------------------
echo "==> Building dist/hook.cjs"
( cd "$ROOT" && corepack pnpm run build )

# Isolated-dir load smoke (P1 exit criterion): copy ONLY dist/hook.cjs to a temp dir with no
# node_modules beside it and require() it, proving (a) jose is bundled into the single artifact,
# (b) n8n internals are lazy/absent at load time, and (c) the tsup footer flattened
# module.exports.default so n8n's require() sees { n8n: { ready: [fn] } } at the top level.
echo "==> Isolated-dir artifact-load smoke"
SMOKE_DIR="$(mktemp -d)"
cp "$ROOT/dist/hook.cjs" "$SMOKE_DIR/"
node -e "const h=require('$SMOKE_DIR/hook.cjs'); if(typeof h?.n8n?.ready?.[0]!=='function'){console.error('hook.n8n.ready[0] is not a function (export shape / footer flatten broken)');process.exit(1)}" \
  || fail "isolated-dir load smoke failed — dist/hook.cjs is not loadable as { n8n: { ready: [fn] } }"
rm -rf "$SMOKE_DIR"

echo "==> Generating e2e keys + env"
( cd "$ROOT" && corepack pnpm exec tsx e2e/gen-env.ts )

# ---------------------------------------------------------------------------
# 2. Secret-leak guard: relaxations must live ONLY in the e2e harness.
# ---------------------------------------------------------------------------
echo "==> Secret-leak guard (Dockerfile must not bake relaxations)"
for forbidden in "N8N_SECURE_COOKIE=false" "N8N_PROXY_AUTH_FORCE_NO_COOKIEPARSER" "NODE_ENV=test"; do
  if grep -q "$forbidden" "$ROOT/Dockerfile"; then
    fail "Dockerfile contains forbidden relaxation: $forbidden"
  fi
done

# ---------------------------------------------------------------------------
# 3. Build the hook artifact image
# ---------------------------------------------------------------------------
echo "==> Building hook artifact image $HOOK_IMAGE_TAG"
docker build -t "$HOOK_IMAGE_TAG" "$ROOT"

# ---------------------------------------------------------------------------
# Helpers used by both the main run and the S12 run
# ---------------------------------------------------------------------------
wait_for_readiness() {
  echo "==> Waiting for /healthz/readiness"
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/healthz/readiness" || echo 000)"
    if [ "$code" = "200" ]; then
      echo "    readiness 200"
      return 0
    fi
    sleep 2
  done
  fail "/healthz/readiness never reached 200"
}

assert_runtime_guards() {
  local cid
  cid="$(compose ps -q n8n)"
  [ -n "$cid" ] || fail "n8n container not found"

  # NODE_ENV must NOT be 'test' (abstract-server's `if(!inTest)` would skip the splice).
  local node_env
  node_env="$(docker exec "$cid" printenv NODE_ENV 2>/dev/null || true)"
  if [ "$node_env" = "test" ]; then
    fail "n8n container resolved NODE_ENV=test — the splice would be silently skipped"
  fi

  # Start-command guard: readiness-as-boot-survival only holds under the default `start`.
  local cmd
  cmd="$(docker inspect -f '{{join .Config.Cmd " "}}' "$cid" 2>/dev/null || true)"
  case "$cmd" in
    *worker* | *webhook*)
      fail "n8n container runs a non-default command ($cmd); readiness semantics do not apply"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# 4. Main run: bring up, seed owner, run scenarios
# ---------------------------------------------------------------------------
echo "==> Bringing up compose (default service)"
compose up -d

wait_for_readiness
assert_runtime_guards

echo "==> Owner-setup preflight"
SETUP_BODY="$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/rest/owner/setup" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$OWNER_EMAIL\",\"firstName\":\"E2E\",\"lastName\":\"Owner\",\"password\":\"$OWNER_PASSWORD\"}")"
SETUP_CODE="$(echo "$SETUP_BODY" | tail -n1)"
SETUP_JSON="$(echo "$SETUP_BODY" | sed '$d')"
if [ "$SETUP_CODE" != "200" ]; then
  fail "owner-setup returned $SETUP_CODE: $SETUP_JSON"
fi
# Assert a JSON body (catches a DB-not-ready 'starting up' text body).
echo "$SETUP_JSON" | grep -q '"data"' || fail "owner-setup did not return JSON data: $SETUP_JSON"

echo "==> Authenticated past-/setup probe (cookie replay, no proxy header, no browser-id)"
LOGIN_HEADERS="$(curl -s -D - -o /dev/null -X POST "$BASE_URL/rest/login" \
  -H 'content-type: application/json' \
  -d "{\"emailOrLdapLoginId\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}")"
# Filter to the n8n-auth Set-Cookie line BEFORE collapsing: login can emit multiple
# Set-Cookie lines (e.g. a browserId cookie) in any order, so picking the first line
# blindly could mangle or grab the wrong cookie.
OWNER_COOKIE="$(echo "$LOGIN_HEADERS" | grep -i '^set-cookie:[[:space:]]*n8n-auth=' | head -n1 | sed -E 's/.*(n8n-auth=[^;]*).*/\1/')"
[ -n "$OWNER_COOKIE" ] || fail "could not capture owner login cookie"
PROBE_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $OWNER_COOKIE" "$BASE_URL/rest/login")"
[ "$PROBE_CODE" = "200" ] || fail "authenticated past-/setup probe returned $PROBE_CODE (not genuinely past /setup)"

echo "==> mock-jwks reachability from the n8n container"
N8N_CID="$(compose ps -q n8n)"
docker exec "$N8N_CID" test -f /opt/proxy-auth/hook.cjs \
  || fail "hook artifact is not mounted at /opt/proxy-auth/hook.cjs"
docker exec "$N8N_CID" wget -q -O- http://mock-jwks/jwks.json >/dev/null 2>&1 \
  || docker exec "$N8N_CID" node -e "fetch('http://mock-jwks/jwks.json').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
  || fail "mock-jwks not reachable from the n8n container by service DNS"

echo "==> Running scenario spec"
( cd "$ROOT" && corepack pnpm exec vitest run --config vitest.e2e.config.ts )

echo "==> Tearing down default service before S12 run"
compose down -v --remove-orphans >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 5. S12 boot-survival: forced cookieParser-not-found → splice SKIPPED
# ---------------------------------------------------------------------------
echo "==> S12 boot-survival (forced cookieParser-not-found)"
N8N_PROXY_AUTH_FORCE_NO_COOKIEPARSER=true compose up -d

wait_for_readiness
assert_runtime_guards

# Probe signal ABSENT: the spliced middleware (which answers 204) never ran, so n8n's SPA
# fallback answers instead — anything BUT 204 means the splice was skipped.
PROBE_INSTALLED="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/__proxy-auth/installed")"
[ "$PROBE_INSTALLED" != "204" ] || fail "S12: probe route returned 204 (splice unexpectedly installed)"

# Seed owner so a valid-header request is judged purely on the (absent) hook.
curl -s -o /dev/null -X POST "$BASE_URL/rest/owner/setup" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$OWNER_EMAIL\",\"firstName\":\"E2E\",\"lastName\":\"Owner\",\"password\":\"$OWNER_PASSWORD\"}" || true

# A valid header must NOT authenticate (the splice never ran).
S12_TOKEN="$( cd "$ROOT" && corepack pnpm exec tsx e2e/mint-token.ts )"
S12_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "user-agent: n8n-proxy-auth-e2e" \
  -H "x-pomerium-jwt-assertion: $S12_TOKEN" \
  "$BASE_URL/rest/login")"
[ "$S12_CODE" = "401" ] || fail "S12: valid-header request returned $S12_CODE (expected 401 — splice skipped)"

echo "==> ALL E2E CHECKS PASSED"
