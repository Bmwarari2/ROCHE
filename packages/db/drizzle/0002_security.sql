-- Security: row-level security, grants, append-only enforcement, versioning and the audit hash
-- chain. See ADR-0002 (tenancy and row-level security). Runs as harbour_owner.
--
-- Roles (created by sql/bootstrap-roles.sql, not by migrations):
--   harbour_owner              owns every object; subject to RLS because every table uses FORCE
--   harbour_app                the API; tenant- and scope-restricted; no DELETE anywhere; INSERT and
--                              SELECT only on append-only tables
--   harbour_auth               Better Auth; the auth schema only
--   harbour_sync               PowerSync logical replication; SELECT on synced tables only
--   harbour_operator           Thapsus operator console; tenant provisioning tables only
--   harbour_worker             outbox relay and cross-tenant schedulers
--   harbour_membership_reader  NOLOGIN owner of the membership lookup function

--------------------------------------------------------------------------------------------------
-- Scope helpers (invoker rights: they run under the caller's RLS, so they can never widen access)
--------------------------------------------------------------------------------------------------

-- A person is in scope when the role is tenant-wide, the person is at one of the user's locations,
-- the user is assigned to them, or the user holds an unexpired break-glass record (section 4).
-- Scope 'none' (for example catering or maintenance roles) never sees a person record.
CREATE OR REPLACE FUNCTION app.person_in_scope(p_person_id uuid, p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_scope() IN ('tenant', 'locations', 'assigned') AND (
  CASE app.current_scope()
    WHEN 'tenant' THEN true
    WHEN 'locations' THEN p_location_id = ANY (app.current_location_ids())
    ELSE false
  END
  OR EXISTS (
    SELECT 1 FROM public.person_assignment pa
    WHERE pa.tenant_id = app.current_tenant_id()
      AND pa.person_id = p_person_id
      AND pa.tenant_user_id = app.current_user_id()
      AND pa.deleted_at IS NULL
      AND pa.valid_from <= now()
      AND (pa.valid_to IS NULL OR pa.valid_to > now())
  )
  OR EXISTS (
    SELECT 1 FROM public.break_glass_event bg
    WHERE bg.tenant_id = app.current_tenant_id()
      AND bg.person_id = p_person_id
      AND bg.tenant_user_id = app.current_user_id()
      AND bg.opened_at <= now()
      AND bg.expires_at > now()
  ))
$$;
--> statement-breakpoint

-- Child records (contacts, allergies, placements, About Me) follow their person's visibility.
CREATE OR REPLACE FUNCTION app.person_visible(p_person_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.person p WHERE p.id = p_person_id)
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Row-level security: enable and FORCE on every table in the public schema
--------------------------------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Standard tenant-owned tables: every command restricted to the transaction's tenant.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'location', 'service', 'tenant_user', 'role', 'role_assignment', 'access_grant',
    'feature_flag', 'outbox_event', 'escalation_chain', 'notification', 'notification_preference',
    'form_submission', 'document', 'room', 'person', 'contact', 'allergy', 'placement', 'about_me',
    'person_assignment', 'break_glass_event'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- The tenant row itself.
CREATE POLICY tenant_self ON public.tenant AS PERMISSIVE FOR ALL TO PUBLIC
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());
--> statement-breakpoint

-- A tenant can read the group it belongs to (consolidated reporting arrives in Phase 3 through a
-- dedicated reporting role, never by widening these policies).
CREATE POLICY tenant_group_member_read ON public.tenant_group AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (id = (SELECT t.group_id FROM public.tenant t WHERE t.id = app.current_tenant_id()));
--> statement-breakpoint

-- Global reference data (NULL tenant) is readable by every tenant; tenants write only their own
-- overrides; only the owner maintains the global rows (seeded from docs/specs).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['form_template', 'rate_table', 'retention_class'] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_or_global_read ON public.%I AS PERMISSIVE FOR SELECT TO PUBLIC '
      'USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY tenant_insert ON public.%I AS PERMISSIVE FOR INSERT TO PUBLIC '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY tenant_update ON public.%I AS PERMISSIVE FOR UPDATE TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY global_maintenance ON public.%I AS PERMISSIVE FOR ALL TO harbour_owner '
      'USING (tenant_id IS NULL) WITH CHECK (tenant_id IS NULL)', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Audit events: a tenant reads and appends its own; events before a tenant is chosen (for example
-- a failed sign-in) are appended with a NULL tenant and are readable only by the operator role.
CREATE POLICY audit_read ON public.audit_event AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY audit_append ON public.audit_event AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    OR (tenant_id IS NULL AND app.current_tenant_id() IS NULL)
  );
--> statement-breakpoint
CREATE POLICY audit_platform_read ON public.audit_event AS PERMISSIVE FOR SELECT TO harbour_operator
  USING (tenant_id IS NULL);
--> statement-breakpoint

-- Version history rows are written by the versioning trigger in the caller's transaction.
CREATE POLICY record_version_read ON public.record_version AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY record_version_append ON public.record_version AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Attribute-based scoping (restrictive policies AND-ed with tenant isolation). They target the
-- application and owner roles; service roles have their own narrowly granted policies instead.
--------------------------------------------------------------------------------------------------

CREATE POLICY person_scope ON public.person AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.person_in_scope(id, location_id))
  WITH CHECK (app.person_in_scope(id, location_id));
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contact', 'allergy', 'placement', 'about_me'] LOOP
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Assignments and break-glass records must not consult `person` (that policy consults them), so
-- they are scoped by role breadth or ownership instead. They hold identifiers only.
CREATE POLICY assignment_scope ON public.person_assignment AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.current_scope() IN ('tenant', 'locations') OR tenant_user_id = app.current_user_id())
  WITH CHECK (app.current_scope() IN ('tenant', 'locations'));
--> statement-breakpoint
CREATE POLICY break_glass_scope ON public.break_glass_event AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant' OR tenant_user_id = app.current_user_id())
  WITH CHECK (tenant_user_id = app.current_user_id() OR app.current_scope() = 'tenant');
--> statement-breakpoint

-- People see their own notifications and preferences; tenant-wide jobs see all of the tenant's.
CREATE POLICY notification_recipient ON public.notification AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (recipient_tenant_user_id = app.current_user_id() OR app.current_scope() = 'tenant')
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY notification_preference_owner ON public.notification_preference AS RESTRICTIVE
  FOR ALL TO harbour_app, harbour_owner
  USING (tenant_user_id = app.current_user_id() OR app.current_scope() = 'tenant')
  WITH CHECK (tenant_user_id = app.current_user_id() OR app.current_scope() = 'tenant');
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Role-specific policies
--------------------------------------------------------------------------------------------------

-- Operator console: provisioning and metering tables only, never people or care data.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_group', 'tenant', 'location', 'service', 'feature_flag'] LOOP
    EXECUTE format(
      'CREATE POLICY operator_provisioning ON public.%I AS PERMISSIVE FOR ALL TO harbour_operator '
      'USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Outbox relay and escalation scheduler work across tenants on these two tables only.
CREATE POLICY worker_relay ON public.outbox_event AS PERMISSIVE FOR ALL TO harbour_worker
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_escalation ON public.notification AS PERMISSIVE FOR ALL TO harbour_worker
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- PowerSync reads synced tables through logical replication, which bypasses RLS; its initial
-- snapshot is a plain SELECT, permitted here. What reaches a device is decided by the sync
-- streams, tested separately in packages/sync (section 5.3).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['location', 'person', 'allergy', 'person_assignment', 'role_assignment'] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE PUBLICATION powersync FOR TABLE
  public.location, public.person, public.allergy, public.person_assignment, public.role_assignment;
--> statement-breakpoint

-- Membership lookup before a tenant is chosen: which tenants does this identity belong to?
-- Owned by a NOLOGIN role whose only privilege is this read, so it cannot be used for anything else.
CREATE POLICY membership_lookup ON public.tenant_user AS PERMISSIVE FOR SELECT
  TO harbour_membership_reader USING (true);
--> statement-breakpoint
CREATE POLICY membership_lookup ON public.tenant AS PERMISSIVE FOR SELECT
  TO harbour_membership_reader USING (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.memberships_for_auth_user(p_auth_user_id text)
RETURNS TABLE (tenant_id uuid, tenant_user_id uuid, tenant_name text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT tu.tenant_id, tu.id, t.name, t.status::text
  FROM public.tenant_user tu
  JOIN public.tenant t ON t.id = tu.tenant_id
  WHERE tu.auth_user_id = p_auth_user_id
    AND tu.status = 'active'
    AND tu.deleted_at IS NULL
    AND t.status IN ('onboarding', 'active')
  ORDER BY t.name
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_membership_reader;
--> statement-breakpoint
ALTER FUNCTION app.memberships_for_auth_user(text) OWNER TO harbour_membership_reader;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_membership_reader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.memberships_for_auth_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.memberships_for_auth_user(text) TO harbour_app;
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Grants
--------------------------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public, app TO harbour_app, harbour_sync, harbour_operator, harbour_worker,
  harbour_membership_reader;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO harbour_app;
--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO harbour_app;
--> statement-breakpoint
-- Soft delete only: the retention engine (Phase 1) purges through its own role.
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM harbour_app;
--> statement-breakpoint
-- Append-only tables.
REVOKE UPDATE ON public.audit_event, public.record_version FROM harbour_app;
--> statement-breakpoint
-- Tenants and groups are provisioned by the operator console; the app may only update settings.
REVOKE INSERT ON public.tenant, public.tenant_group FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE ON public.tenant_group FROM harbour_app;
--> statement-breakpoint
-- Global reference data is maintained by the owner.
ALTER DEFAULT PRIVILEGES FOR ROLE harbour_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO harbour_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE harbour_owner IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO harbour_app;
--> statement-breakpoint

GRANT SELECT ON public.location, public.person, public.allergy, public.person_assignment,
  public.role_assignment TO harbour_sync;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_group, public.tenant, public.location, public.service,
  public.feature_flag TO harbour_operator;
--> statement-breakpoint
GRANT SELECT ON public.audit_event TO harbour_operator;
--> statement-breakpoint
-- Operator transactions set app.tenant_id to the tenant they act on, so version history is kept.
GRANT INSERT ON public.record_version TO harbour_operator;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.outbox_event, public.notification TO harbour_worker;
--> statement-breakpoint
GRANT SELECT ON public.tenant_user, public.tenant TO harbour_membership_reader;
--> statement-breakpoint

GRANT USAGE ON SCHEMA auth TO harbour_auth;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO harbour_auth;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE harbour_owner IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harbour_auth;
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Append-only enforcement (defence in depth on top of the missing grants)
--------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed; record a correction instead', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_event', 'record_version'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Mutable aggregates: version bump, immutable identity columns, temporal history
--------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.touch_mutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'id cannot change on %', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) ->> 'tenant_id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'tenant_id') THEN
    RAISE EXCEPTION 'tenant_id cannot change on %', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(app.current_user_id(), NEW.updated_by);
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.capture_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
BEGIN
  INSERT INTO public.record_version
    (tenant_id, table_name, record_id, record_version, valid_from, valid_to, changed_by, data)
  VALUES (
    COALESCE((old_row ->> 'tenant_id')::uuid, CASE WHEN TG_TABLE_NAME = 'tenant' THEN OLD.id END),
    TG_TABLE_NAME, OLD.id, OLD.version, OLD.updated_at, now(), app.current_user_id(), old_row
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant', 'location', 'service', 'tenant_user', 'role', 'role_assignment', 'access_grant',
    'feature_flag', 'escalation_chain', 'notification_preference', 'form_template',
    'form_submission', 'document', 'room', 'person', 'contact', 'allergy', 'placement', 'about_me',
    'person_assignment', 'break_glass_event'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format(
      'CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.tenant_group
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Tamper-evident audit trail: a SHA-256 hash chain per tenant (section 5.3 logging)
--------------------------------------------------------------------------------------------------

-- Chain heads hold hashes only. No role but the owner can read or write them.
CREATE TABLE app.audit_chain_head (
  chain_key text PRIMARY KEY,
  last_position bigint NOT NULL,
  last_hash text NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON app.audit_chain_head FROM PUBLIC;
--> statement-breakpoint

-- Canonical form of an event for hashing: every column except the two hash columns, as jsonb text
-- (keys sorted by jsonb) with timestamps rendered in UTC regardless of the session time zone.
CREATE OR REPLACE FUNCTION app.audit_event_canonical(e public.audit_event) RETURNS text
LANGUAGE sql STABLE SET "TimeZone" = 'UTC' AS $$
  SELECT (to_jsonb(e) - 'hash' - 'prev_hash')::text
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_event_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET "TimeZone" = 'UTC' AS $$
DECLARE
  k text := COALESCE(NEW.tenant_id::text, 'platform');
  head app.audit_chain_head%ROWTYPE;
BEGIN
  INSERT INTO app.audit_chain_head (chain_key, last_position, last_hash)
  VALUES (k, 0, repeat('0', 64))
  ON CONFLICT (chain_key) DO NOTHING;

  -- The row lock serialises appends per tenant, so chain order equals commit order.
  SELECT * INTO head FROM app.audit_chain_head WHERE chain_key = k FOR UPDATE;

  NEW.chain_position := head.last_position + 1;
  NEW.prev_hash := head.last_hash;
  NEW.hash := encode(digest(NEW.prev_hash || '|' || app.audit_event_canonical(NEW), 'sha256'), 'hex');

  UPDATE app.audit_chain_head
  SET last_position = NEW.chain_position, last_hash = NEW.hash
  WHERE chain_key = k;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_event_chain BEFORE INSERT ON public.audit_event
  FOR EACH ROW EXECUTE FUNCTION app.audit_event_chain();
--> statement-breakpoint

-- Recomputes the chain for the caller's tenant (under RLS) and returns the first broken position,
-- or NULL when the chain is intact.
CREATE OR REPLACE FUNCTION app.verify_audit_chain() RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public SET "TimeZone" = 'UTC' AS $$
DECLARE
  e public.audit_event;
  expected_prev text := repeat('0', 64);
  expected_position bigint := 1;
BEGIN
  FOR e IN
    SELECT * FROM public.audit_event
    WHERE tenant_id = app.current_tenant_id()
    ORDER BY chain_position
  LOOP
    IF e.chain_position <> expected_position
       OR e.prev_hash <> expected_prev
       OR e.hash <> encode(digest(e.prev_hash || '|' || app.audit_event_canonical(e), 'sha256'), 'hex')
    THEN
      RETURN e.chain_position;
    END IF;
    expected_prev := e.hash;
    expected_position := expected_position + 1;
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Statutory figures: no two rows for the same key, nation and tenant may overlap in time
--------------------------------------------------------------------------------------------------

ALTER TABLE public.rate_table ADD CONSTRAINT rate_table_no_overlap EXCLUDE USING gist (
  key WITH =,
  nation WITH =,
  (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  daterange(valid_from, valid_to, '[)') WITH &&
);
