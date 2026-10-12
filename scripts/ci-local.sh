#!/usr/bin/env bash
# Runs the ci.yml quality gates on this machine, for when GitHub-hosted minutes are unavailable.
#
# Usage: scripts/ci-local.sh <base-sha> [label,label]
#   <base-sha>  the pull request's base commit (commit messages, docs gate, OpenAPI diff, gitleaks)
#   labels      the pull request's labels, for the docs gate (for example "clinical,data-protection")
#
# Needs: Node and pnpm per .nvmrc and package.json, a local Postgres reachable at
# HARBOUR_TEST_ADMIN_URL (see docs/runbooks/local-development.md), Chromium for Playwright, and
# gitleaks and oasdiff on PATH. The e2e step drops and recreates the local `harbour` database.
# Not covered here (no Docker or licence): container image builds, CodeQL, Trivy and Maestro.
set -uo pipefail

BASE="${1:?usage: scripts/ci-local.sh <base-sha> [labels]}"
LABELS="${2:-}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

export CI=true TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
export HARBOUR_TEST_ADMIN_URL="${HARBOUR_TEST_ADMIN_URL:-postgres://harbour_admin:harbour_admin_local@localhost:5432/postgres}"
export DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:-$HARBOUR_TEST_ADMIN_URL}"

LOG_DIR="${CI_LOCAL_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"
HEAD_SHA="$(git rev-parse HEAD)"
declare -a RESULTS=()
FAILED=0

step() {
  local name="$1"
  shift
  local log="$LOG_DIR/$(echo "$name" | tr -c 'a-zA-Z0-9' '-').log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    RESULTS+=("pass  $name ($((SECONDS - start))s)")
  else
    RESULTS+=("FAIL  $name ($((SECONDS - start))s, log: $log)")
    FAILED=1
  fi
}

event_file() {
  local file="$LOG_DIR/event.json"
  node -e '
    const labels = (process.argv[1] || "").split(",").filter(Boolean).map((name) => ({ name }));
    process.stdout.write(JSON.stringify({ pull_request: { labels } }));
  ' "$LABELS" >"$file"
  echo "$file"
}

openapi_breaking() {
  if git cat-file -e "$BASE:apps/api/openapi.json" 2>/dev/null; then
    git show "$BASE:apps/api/openapi.json" >"$LOG_DIR/base-openapi.json"
    oasdiff breaking "$LOG_DIR/base-openapi.json" apps/api/openapi.json --fail-on ERR
  else
    echo "No OpenAPI document on the base commit."
  fi
}

openapi_current() {
  pnpm --filter @harbour/api openapi &&
    pnpm --filter @harbour/contracts generate:client &&
    git diff --exit-code -- apps/api/openapi.json packages/contracts/src/client/api-types.ts
}

e2e_database() {
  pnpm --filter @harbour/db bootstrap &&
    pnpm --filter @harbour/db reset &&
    pnpm --filter @harbour/db bootstrap &&
    pnpm --filter @harbour/db migrate &&
    pnpm --filter @harbour/db seed &&
    HARBOUR_SEED_DEMO_USERS=1 HARBOUR_DEMO_MFA=off pnpm --filter @harbour/api seed:users
}

EVENT="$(event_file)"

step "Install" pnpm install --frozen-lockfile
# Lint, format and conventions
step "Biome" pnpm exec biome ci .
step "Commit messages" pnpm exec commitlint --from "$BASE" --to HEAD
step "Licences" node scripts/check-licences.mjs
step "Docs gate" env GITHUB_EVENT_PATH="$EVENT" BASE_SHA="$BASE" HEAD_SHA="$HEAD_SHA" node scripts/check-docs-gate.mjs
step "Medicines tests" env BASE_SHA="$BASE" HEAD_SHA="$HEAD_SHA" node scripts/check-medicines-tests.mjs
step "Markdown links" node scripts/check-markdown-links.mjs
# Types
step "Typecheck" pnpm turbo run typecheck
# Unit, domain and RLS isolation tests
step "Tests" pnpm turbo run test --concurrency=2
step "Domain coverage" pnpm --filter @harbour/domain test:coverage
# API contract
step "OpenAPI current" openapi_current
step "OpenAPI breaking changes" openapi_breaking
# Design system and builds
step "Storybook build" pnpm --filter @harbour/ui build-storybook
step "Build API and web" pnpm turbo run build --filter=@harbour/api --filter=@harbour/web
# Web journeys and accessibility
step "E2E database" e2e_database
step "Playwright and axe" pnpm --filter @harbour/web test:e2e
# Security
step "Gitleaks" gitleaks git . --config .gitleaks.toml --redact --log-opts="$BASE..HEAD"
step "pnpm audit" pnpm audit --prod --audit-level high

echo "Local CI for $HEAD_SHA (base $BASE)"
printf '%s\n' "${RESULTS[@]}"
echo "Logs: $LOG_DIR"
exit "$FAILED"
