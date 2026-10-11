-- Runs once, on the first start of an empty data volume, as harbour_admin.
-- pgAudit needs its extension in each database for DDL event triggers; pg_stat_statements
-- gives query statistics. Installing both in template1 means the harbour database, which
-- `pnpm db:bootstrap` creates later, inherits them. Migrations also run
-- CREATE EXTENSION IF NOT EXISTS, as they must on RDS.
CREATE EXTENSION IF NOT EXISTS pgaudit;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

\connect template1
CREATE EXTENSION IF NOT EXISTS pgaudit;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
