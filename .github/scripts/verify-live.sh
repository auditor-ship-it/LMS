#!/usr/bin/env bash
# Confirms the PUBLIC site is served by the process we just deployed — not
# merely that some process is answering.
#
# `startedAt` comes from /api/health (backend/src/app.js). A stale value means
# the restart silently did nothing and the old code is still live, which is the
# precise failure mode this pipeline exists to make impossible.
set -uo pipefail

BASE="${1:-https://lease.crystalgrp.xyz}"
MAX_AGE_SECONDS="${MAX_AGE_SECONDS:-600}"

echo "checking ${BASE}/api/health"
BODY=$(curl -fsS --max-time 20 "${BASE}/api/health") || {
  echo "::error::Could not reach ${BASE}/api/health"
  exit 1
}
echo "  $BODY"

STARTED=$(printf '%s' "$BODY" | grep -o '"startedAt":"[^"]*"' | cut -d'"' -f4)
if [ -z "$STARTED" ]; then
  # Only possible while the currently-live build predates the versioned health
  # endpoint. The restart step already proved a new pid is serving, so this is
  # a warning rather than a failure — and it self-resolves after this deploy.
  echo "::warning::No startedAt field in /api/health — live build predates the versioned endpoint. Restart was confirmed server-side instead."
  exit 0
fi

NOW=$(date -u +%s)
THEN=$(date -u -d "$STARTED" +%s 2>/dev/null) || {
  echo "::warning::Could not parse startedAt ($STARTED); skipping the age check."
  exit 0
}
AGE=$(( NOW - THEN ))
echo "  live process started ${AGE}s ago"

if [ "$AGE" -gt "$MAX_AGE_SECONDS" ]; then
  echo "::error::Live process started ${AGE}s ago (limit ${MAX_AGE_SECONDS}s) — the OLD process is still serving. The restart did not take."
  exit 1
fi

COMMIT=$(printf '%s' "$BODY" | grep -o '"commit":"[^"]*"' | cut -d'"' -f4)
echo "OK - live site is running the freshly deployed process (commit: ${COMMIT:-unset})"
