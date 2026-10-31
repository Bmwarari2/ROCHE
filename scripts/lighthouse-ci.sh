#!/usr/bin/env bash
# Lighthouse CI for the web tier (apps/web/lighthouserc.cjs): starts the built API
# (apps/api/dist) and the built web app (next start), as the Playwright journeys do, runs
# `pnpm --filter @harbour/web lighthouse`, and stops both. Needs `pnpm turbo run build
# --filter=@harbour/api --filter=@harbour/web` and the e2e demo seed (HARBOUR_DEMO_MFA=off) first.
# Used by the e2e-web job in .github/workflows/ci.yml and by scripts/ci-local.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
WEB_URL="${WEB_URL:-http://localhost:3000}"
API_URL="${API_URL:-http://localhost:4000}"
LOG_DIR="${LIGHTHOUSE_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$url"; then return 0; fi
    sleep 2
  done
  echo "$name did not start: see $LOG_DIR" >&2
  return 1
}

(cd apps/api && AUTH_SIGN_IN_PER_MINUTE=600 exec node dist/server.js) >"$LOG_DIR/api.log" 2>&1 &
pids+=("$!")
(cd apps/web && API_URL="$API_URL" PUBLIC_WEB_URL="$WEB_URL" NEXT_TELEMETRY_DISABLED=1 \
  exec node_modules/.bin/next start --port "${WEB_URL##*:}") >"$LOG_DIR/web.log" 2>&1 &
pids+=("$!")

wait_for "$API_URL/health" "The API"
wait_for "$WEB_URL/api/health" "The web app"

WEB_URL="$WEB_URL" pnpm --filter @harbour/web lighthouse
