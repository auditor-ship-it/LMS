#!/usr/bin/env bash
# Restarts the Lease Management backend ON THE VPS and waits for it to serve
# traffic again. Run as the lease-management user.
#
# Why SIGTERM and not `systemctl restart`: the deploy account has no
# passwordless sudo, but the unit runs as that same user with Restart=always
# and RestartSec=5. Killing the main process therefore IS a restart, and
# systemd brings it back within seconds.
#
# Why this waits and verifies: Node reads its source once at startup. A deploy
# that copies files and does not restart leaves the OLD code serving with no
# error anywhere — production ran a nine-day-old process exactly that way.
set -uo pipefail

UNIT=lease-management
PORT="${BACKEND_PORT:-5300}"

OLD=$(systemctl show -p MainPID --value "$UNIT")
echo "restarting $UNIT (old pid ${OLD:-none})"

if [ -n "$OLD" ] && [ "$OLD" != "0" ]; then
  kill -TERM "$OLD" 2>/dev/null || echo "  (could not signal $OLD — may already be down)"
fi

for i in $(seq 1 30); do
  sleep 2
  NEW=$(systemctl show -p MainPID --value "$UNIT")
  STATE=$(systemctl show -p ActiveState --value "$UNIT")
  if [ -n "$NEW" ] && [ "$NEW" != "0" ] && [ "$NEW" != "$OLD" ] && [ "$STATE" = "active" ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)
    if [ "$CODE" = "200" ]; then
      echo "up: new pid $NEW, healthy after $((i * 2))s"
      exit 0
    fi
  fi
  echo "  waiting ($i/30) state=$STATE pid=$NEW"
done

echo "ERROR: $UNIT did not come back healthy within 60s"
journalctl -u "$UNIT" -n 40 --no-pager 2>/dev/null || true
exit 1
