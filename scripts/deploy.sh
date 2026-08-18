#!/usr/bin/env bash
#
# Production deploy for the VPS. Run from the repo root on the server:
#
#     ./scripts/deploy.sh
#
# Why this exists: deployment was a set of commands typed by hand, and the
# backend restart was the easy one to skip. That left a NEW frontend talking to
# an OLD backend — the UI showed stage counts of 0 and 404s on routes that
# plainly existed in the repo, with nothing in any log to say why. This script
# makes the two halves ship together and REFUSES to report success unless the
# running backend reports the commit it just deployed.
#
# Configure via environment (or an .env.deploy next to this script):
#   APP_NAME     pm2 process name                (default: lease-backend)
#   HEALTH_URL   public health endpoint          (default: https://lease.crystalgrp.xyz/api/health)
#   BRANCH       branch to deploy                (default: main)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f scripts/.env.deploy ] && . scripts/.env.deploy

APP_NAME="${APP_NAME:-lease-backend}"
HEALTH_URL="${HEALTH_URL:-https://lease.crystalgrp.xyz/api/health}"
BRANCH="${BRANCH:-main}"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
# The frontend bakes its API URL in AT BUILD TIME. If VITE_API_URL is missing
# the bundle silently falls back to http://localhost:4001/api — which, served
# to a user's browser, points at THEIR machine, not the server. Checked before
# anything is touched, because the failure is invisible until someone loads the
# site and every request dies.
step "Preflight"
[ -f frontend/.env.production ] || [ -n "${VITE_API_URL:-}" ] \
  || die "No frontend/.env.production and no VITE_API_URL. The build would hard-code http://localhost:4001/api. Create frontend/.env.production with: VITE_API_URL=https://lease.crystalgrp.xyz/api"
[ -f backend/.env ] || die "backend/.env is missing — the backend will exit at boot on its required-vars check."
command -v curl >/dev/null || die "curl is required to verify the deploy."
echo "  app=$APP_NAME  branch=$BRANCH  health=$HEALTH_URL"

# ---------------------------------------------------------------- source
step "Fetching $BRANCH"
git fetch --all --prune
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
DEPLOY_SHA="$(git rev-parse --short HEAD)"
echo "  deploying $DEPLOY_SHA — $(git log -1 --format=%s)"

# ---------------------------------------------------------------- backend
# Backend FIRST. The frontend may call routes that only exist in the new
# backend, so shipping the frontend first guarantees a window of 404s.
step "Backend: install"
(cd backend && npm ci --omit=dev)

step "Backend: restart"
# GIT_COMMIT is what /api/health reports back; without it the verification
# below cannot tell which build is running.
export GIT_COMMIT="$DEPLOY_SHA"
if command -v pm2 >/dev/null && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  # --update-env so the new GIT_COMMIT reaches the process; pm2 reuses the old
  # environment without it, and the health check would report a stale commit.
  pm2 restart "$APP_NAME" --update-env
  pm2 save
elif systemctl list-units --type=service 2>/dev/null | grep -q "$APP_NAME"; then
  sudo systemctl restart "$APP_NAME"
else
  die "No pm2 process or systemd unit named '$APP_NAME'. Set APP_NAME to the real one (pm2 list / systemctl list-units)."
fi

# ---------------------------------------------------------------- verify
# The whole point of the script. A restart that silently did nothing is the
# failure being guarded against, so this must run before the frontend build.
step "Verify backend is the build we just deployed"
RUNNING=""
for i in $(seq 1 20); do
  sleep 2
  BODY="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || true)"
  RUNNING="$(printf '%s' "$BODY" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')"
  [ -n "$RUNNING" ] && break
  echo "  waiting for backend to answer ($i/20)"
done
[ -n "$RUNNING" ] || die "Backend never answered $HEALTH_URL. Check: pm2 logs $APP_NAME --lines 50"
if [ "$RUNNING" != "$DEPLOY_SHA" ]; then
  die "Backend reports commit '$RUNNING' but we deployed '$DEPLOY_SHA'.
The old process is still serving. It did not restart, or pm2 is running a
different copy of the code. Check: pm2 describe $APP_NAME | grep 'script path'"
fi
echo "  OK — backend is running $RUNNING"

# ---------------------------------------------------------------- frontend
step "Frontend: build"
(cd frontend && npm ci && rm -rf dist && npm run build)
[ -d frontend/dist ] || die "frontend/dist was not produced."

# A built bundle that still contains the localhost fallback would break every
# API call in the browser. Cheap to check, and the symptom is otherwise blamed
# on the backend.
if grep -rq "localhost:4001" frontend/dist/assets 2>/dev/null; then
  die "Built frontend contains http://localhost:4001 — VITE_API_URL was not set at build time. Fix frontend/.env.production and re-run."
fi

step "Done — $DEPLOY_SHA is live"
curl -fsS --max-time 10 "$HEALTH_URL"; echo
echo "If the browser still shows old data, hard-reload (Ctrl+Shift+R) — index.html can be cached."
