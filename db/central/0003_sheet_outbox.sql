-- 0003: write-behind queue for the Google Sheets mirror (CENTRAL_SHEETS_MIRROR=on).
-- Idempotent. Run as the database admin, after 0001. Nothing reads it unless the mirror is switched on.
-- Every app write to a lease.<tab> table also inserts one row here (same transaction); the
-- LMS worker replays the rows to the real Sheet in id order, one tab at a time.

SET ROLE lease_owner;

CREATE TABLE IF NOT EXISTS lease.sheet_outbox (
  id           bigserial PRIMARY KEY,
  workbook_key text        NOT NULL,
  tab          text        NOT NULL,
  op           text        NOT NULL CHECK (op IN ('write', 'append', 'delete')),
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  attempts     integer     NOT NULL DEFAULT 0,
  retry_after  timestamptz,
  last_error   text,
  done_at      timestamptz
);
CREATE INDEX IF NOT EXISTS sheet_outbox_pending_idx ON lease.sheet_outbox (id) WHERE done_at IS NULL;
COMMENT ON TABLE lease.sheet_outbox IS 'Write-behind queue: central writes waiting to be replayed to the Google Sheet';

RESET ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON lease.sheet_outbox TO lease_rw;
GRANT USAGE, SELECT ON SEQUENCE lease.sheet_outbox_id_seq TO lease_rw;
GRANT SELECT ON lease.sheet_outbox TO lease_ro;
