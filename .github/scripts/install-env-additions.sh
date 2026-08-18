#!/usr/bin/env bash
#
# Merges staged environment variables into the systemd EnvironmentFile.
#
# MUST be run with sudo: /etc/lease-management/lease-management.env is owned by
# root:lease-management at mode 640, so the deploy account can read it but not
# write it. That is a sensible arrangement — it keeps production credentials
# out of reach of anything that merely deploys code — and it is why this one
# step cannot be automated by the pull-based deployer.
#
#   sudo bash ~/deploy/repo/.github/scripts/install-env-additions.sh
#
# Safe to run more than once: keys already present are skipped, never
# duplicated or overwritten, so a second run is a no-op.
set -uo pipefail

TARGET="${TARGET_ENV:-/etc/lease-management/lease-management.env}"
SOURCE="${SOURCE_ENV:-/home/lease-management/deploy/env-additions.env}"
UNIT="${UNIT:-lease-management}"
BACKUP_DIR="${BACKUP_DIR:-/home/lease-management/backups}"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: must run as root (use sudo)"; exit 1; }
[ -f "$TARGET" ] || { echo "ERROR: $TARGET not found"; exit 1; }
[ -f "$SOURCE" ] || { echo "ERROR: $SOURCE not found — nothing staged to install"; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
cp "$TARGET" "$BACKUP_DIR/lease-management.env.$STAMP.bak"
chmod 600 "$BACKUP_DIR/lease-management.env.$STAMP.bak"
echo "backed up -> $BACKUP_DIR/lease-management.env.$STAMP.bak"

BEFORE=$(grep -cE '^[A-Z_]+=' "$TARGET")
echo "keys before: $BEFORE"

added=0
skipped=0
# Appended, never edited in place: an existing production value is always the
# authority. If a key is already set here, the staged one is ignored.
{
  printf '\n# --- added %s ---\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    if grep -qE "^${key}=" "$TARGET"; then
      echo "  skip (already set): $key" >&2
      skipped=$((skipped + 1))
    else
      printf '%s\n' "$line"
      echo "  add: $key" >&2
      added=$((added + 1))
    fi
  done < "$SOURCE"
} >> "$TARGET"

# Ownership and mode must survive untouched — the service account reads this
# file by group, and anything wider would expose production credentials.
chown root:lease-management "$TARGET"
chmod 640 "$TARGET"

AFTER=$(grep -cE '^[A-Z_]+=' "$TARGET")
echo "keys after : $AFTER"
echo "added: $((AFTER - BEFORE))"

echo "restarting $UNIT ..."
systemctl restart "$UNIT"
sleep 6
systemctl is-active --quiet "$UNIT" && echo "service: active" || {
  echo "ERROR: service failed to start — restoring backup"
  cp "$BACKUP_DIR/lease-management.env.$STAMP.bak" "$TARGET"
  chown root:lease-management "$TARGET"; chmod 640 "$TARGET"
  systemctl restart "$UNIT"
  exit 1
}

PORT=$(grep -oE '^PORT=.*' "$TARGET" | cut -d= -f2 | tr -d '"' | head -1)
echo "health: $(curl -s --max-time 8 "http://127.0.0.1:${PORT:-5300}/api/health")"

# The staged file holds live credentials; remove it once installed.
shred -u "$SOURCE" 2>/dev/null || rm -f "$SOURCE"
echo "staged file removed"
echo
echo "Done. Confirm the integrations came up:"
echo "  journalctl -u $UNIT -n 30 --no-pager | grep -iE 'sales-crm|accounts-api|mail'"
