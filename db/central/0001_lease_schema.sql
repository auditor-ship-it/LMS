-- 0001: central schema `lease` for LMS + Accounts-Collection (DATA_SOURCE=central).
-- Idempotent. Run as the database admin (it creates roles if the platform has not yet).
--
-- The spreadsheet tabs both apps use become one typed table per tab, created and
-- filled by backend/scripts/central/load-lease.mjs (the single loader/rebuild job):
--   lease.<tab_slug>(row_number int PK = sheet row, c<NNN>_<header> text|double precision|boolean ..., _extra jsonb)
-- This file holds the fixed part: roles, schema, and the tab/column registry the apps
-- use to turn table rows back into the row arrays their business logic indexes into.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['lease_owner', 'lease_rw', 'lease_ro'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lease_rw, lease_ro', current_database());
END $$;

CREATE SCHEMA IF NOT EXISTS lease AUTHORIZATION lease_owner;
REVOKE ALL ON SCHEMA lease FROM PUBLIC;
GRANT USAGE ON SCHEMA lease TO lease_rw, lease_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE lease_owner IN SCHEMA lease GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lease_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE lease_owner IN SCHEMA lease GRANT SELECT ON TABLES TO lease_ro;

SET ROLE lease_owner;

-- One row per loaded tab (workbook_key = the central sync's workbook name).
CREATE TABLE IF NOT EXISTS lease.sheet_tab (
  workbook_key        text NOT NULL,
  tab                 text NOT NULL,
  table_name          text NOT NULL UNIQUE,
  loaded_at           timestamptz,
  source_rows         integer,
  source_workbook_key text,
  app_written_at      timestamptz,          -- set by the apps on every write; the loader refuses to overwrite such a tab without --force
  PRIMARY KEY (workbook_key, tab)
);
COMMENT ON TABLE lease.sheet_tab IS 'Registry: which lease.<table> holds which workbook tab';

-- Sheet columns in position order: header text (row 1 of the sheet) and the typed column holding it.
CREATE TABLE IF NOT EXISTS lease.sheet_column (
  table_name  text NOT NULL REFERENCES lease.sheet_tab (table_name) ON UPDATE CASCADE ON DELETE CASCADE,
  ordinal     integer NOT NULL CHECK (ordinal >= 0),          -- 0 = column A
  header      jsonb NOT NULL DEFAULT '""'::jsonb,             -- as the sheet API returned it (usually a string)
  column_name text,                                           -- NULL: cells of this column live in <table>._extra
  data_type   text CHECK (data_type IN ('text', 'double precision', 'boolean')),
  PRIMARY KEY (table_name, ordinal)
);
COMMENT ON TABLE lease.sheet_column IS 'Header row + column typing of every lease.<table>';

RESET ROLE;

-- Tables created before the default privileges existed (re-runs are harmless).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA lease TO lease_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA lease TO lease_ro;
