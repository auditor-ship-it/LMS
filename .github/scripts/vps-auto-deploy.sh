#!/usr/bin/env bash
#
# PULL-BASED AUTO-DEPLOY, run by cron on the VPS.
#
# Why pull and not push: a GitHub Actions workflow deploying INTO the server
# has to authenticate, which means storing an SSH private key as a repo secret.
# Turning it around removes that entirely — the server fetches a public repo
# over plain HTTPS, so there is no credential to store, rotate or leak, and
# nothing to configure in GitHub at all. Merge to main is the only trigger.
#
# What it does, every couple of minutes:
#   1. fetch origin/main
#   2. if the tip is already deployed, exit silently
#   3. otherwise build, sync, restart, and verify the service actually came up
#
# Safety properties, all deliberate:
#   * A build failure aborts BEFORE anything is copied into the live app, so a
#     broken commit cannot take the site down — the running version keeps
#     serving.
#   * The "already deployed" marker is only written after a VERIFIED restart,
#     so a failure retries on the next tick instead of being skipped forever.
#   * A commit that fails repeatedly is backed off after MAX_ATTEMPTS rather
#     than rebuilt every two minutes for eternity.
#   * Only backend/src and frontend/dist are replaced. backend/.env and the
#     root-owned /etc/lease-management env file are never touched, which is why
#     no environment variables need deploying — they already live on the box.
set -uo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$HOME/deploy}"
REPO="$DEPLOY_DIR/repo"
APP="${APP_DIR:-$HOME/app}"
LOG="$DEPLOY_DIR/deploy.log"
STATE="$DEPLOY_DIR/deployed.sha"
FAILED="$DEPLOY_DIR/failed.state"
BRANCH="${DEPLOY_BRANCH:-main}"
MAX_ATTEMPTS=3

mkdir -p "$DEPLOY_DIR" "$HOME/backups"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# Only one deploy at a time. Cron fires every couple of minutes and a build
# takes longer than that, so overlapping runs are guaranteed without this.
exec 9>"$DEPLOY_DIR/.lock"
flock -n 9 || exit 0

[ -d "$REPO/.git" ] || { log "FATAL: $REPO is not a git checkout"; exit 1; }
cd "$REPO" || exit 1

git fetch --quiet origin "$BRANCH" 2>>"$LOG" || { log "git fetch failed"; exit 1; }
REMOTE=$(git rev-parse "origin/$BRANCH")
DEPLOYED=$(cat "$STATE" 2>/dev/null || echo none)

# Nothing new. Silent on purpose — this runs every two minutes and must not
# fill the log with "no change".
[ "$REMOTE" = "$DEPLOYED" ] && exit 0

# Back off a commit that keeps failing, so a bad merge does not rebuild
# forever. Cleared automatically as soon as a different commit appears.
if [ -f "$FAILED" ]; then
  read -r F_SHA F_COUNT < "$FAILED"
  if [ "$F_SHA" = "$REMOTE" ] && [ "${F_COUNT:-0}" -ge "$MAX_ATTEMPTS" ]; then
    exit 0
  fi
fi

SHORT=$(git rev-parse --short "$REMOTE")
log "=== deploying $SHORT (was ${DEPLOYED:0:7})"

fail() {
  log "FAILED: $*"
  if [ -f "$FAILED" ]; then
    read -r F_SHA F_COUNT < "$FAILED"
    [ "$F_SHA" = "$REMOTE" ] && F_COUNT=$((F_COUNT + 1)) || F_COUNT=1
  else
    F_COUNT=1
  fi
  printf '%s %s\n' "$REMOTE" "$F_COUNT" > "$FAILED"
  [ "$F_COUNT" -ge "$MAX_ATTEMPTS" ] && log "  giving up on $SHORT after $F_COUNT attempts; push a new commit to retry"
  exit 1
}

git reset --hard --quiet "origin/$BRANCH" || fail "git reset"

# ---------------------------------------------------------------- build
# Built here, in the checkout, NOT in the live app directory. Nothing under
# ~/app is touched until the build has succeeded.
#
# The API URL is taken from the live app's own .env.production so this script
# never has to know it. Without it the bundle silently falls back to
# http://localhost:4001/api, which in a browser points at the visitor's own
# machine and breaks every request.
if [ -f "$APP/frontend/.env.production" ]; then
  cp "$APP/frontend/.env.production" "$REPO/frontend/.env.production"
else
  log "  WARNING: no $APP/frontend/.env.production — build may fall back to localhost"
fi

log "  installing frontend deps"
(cd "$REPO/frontend" && npm ci --no-audit --no-fund) >>"$LOG" 2>&1 || fail "frontend npm ci"

log "  building frontend"
(cd "$REPO/frontend" && npm run build) >>"$LOG" 2>&1 || fail "frontend build"

# Refuse to ship a bundle pointing at localhost, whatever the cause.
if grep -rq "localhost:4001" "$REPO/frontend/dist/assets" 2>/dev/null; then
  fail "built bundle contains localhost:4001 — refusing to deploy it"
fi

# Catches syntax errors, bad import paths and case-mismatched imports before
# the service is restarted onto them. Same check CI runs.
#
# The checkout needs its own node_modules for this: the smoke test IMPORTS
# every module, and an import of 'express' cannot resolve without them. Full
# install, not --omit=dev, because a missing dependency should surface here
# rather than after the service has already been restarted onto it.
if [ -f "$REPO/.github/scripts/smoke-import.mjs" ]; then
  log "  installing backend deps (for the smoke test)"
  (cd "$REPO/backend" && npm ci --no-audit --no-fund) >>"$LOG" 2>&1 || fail "backend npm ci in checkout"

  log "  smoke-testing backend modules"
  ( cd "$REPO/backend" \
    && GOOGLE_PROJECT_ID=ci GOOGLE_CLIENT_EMAIL=ci@example.com GOOGLE_PRIVATE_KEY=ci \
       GOOGLE_SHEET_ID=ci MONGODB_URI=mongodb://127.0.0.1:1 MONGO_DB_NAME=ci \
       node ../.github/scripts/smoke-import.mjs ) >>"$LOG" 2>&1 || fail "backend smoke test"
fi

# ---------------------------------------------------------------- deploy
log "  backing up current release"
tar czf "$HOME/backups/pre-deploy-$(date +%Y%m%d-%H%M%S).tar.gz" \
  -C "$APP" backend/src frontend/dist 2>/dev/null
ls -t "$HOME"/backups/*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm --

log "  syncing files"
# --delete so files removed in git also disappear here. Scoped to src and dist:
# backend/.env sits outside both and must survive untouched.
rsync -a --delete "$REPO/backend/src/" "$APP/backend/src/" || fail "rsync backend/src"
cp "$REPO/backend/package.json" "$REPO/backend/package-lock.json" "$APP/backend/" || fail "copy package files"
rsync -a --delete "$REPO/frontend/dist/" "$APP/frontend/dist/" || fail "rsync frontend/dist"

log "  installing production deps"
(cd "$APP/backend" && npm ci --omit=dev --no-audit --no-fund) >>"$LOG" 2>&1 || fail "backend npm ci"

# ---------------------------------------------------------------- restart
# The whole reason this exists. Node reads its source once at boot: copying
# files changes nothing until the process is replaced. Production served a
# nine-day-old process exactly that way.
log "  restarting service"
bash "$REPO/.github/scripts/restart-backend.sh" >>"$LOG" 2>&1 || fail "service did not come back healthy"

printf '%s\n' "$REMOTE" > "$STATE"
rm -f "$FAILED"
log "OK deployed $SHORT"
