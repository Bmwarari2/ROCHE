-- Foundation: extensions and the `app` schema of request-context functions used by column
-- defaults and row-level security policies (ADR-0002). Runs as harbour_owner.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

-- UUIDv7 (RFC 9562): 48-bit Unix millisecond timestamp, version 7, variant 10, random bits.
-- Postgres 18 has uuidv7(); this function keeps Postgres 16/17 compatible and sortable ids.
CREATE OR REPLACE FUNCTION app.uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$;
--> statement-breakpoint

-- Request context. The API sets these with set_config(..., true) at the start of every
-- transaction. Transaction-local settings revert to '' (not NULL) afterwards, hence NULLIF.
-- A missing or malformed value yields NULL or an error: every policy then fails closed.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
-- 'tenant' | 'locations' | 'assigned' | 'none' (default): who the user may act on (section 4).
CREATE OR REPLACE FUNCTION app.current_scope() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.scope', true), ''), 'none')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_location_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.location_ids', true), ''), ',')::uuid[],
    '{}'::uuid[]
  )
$$;
