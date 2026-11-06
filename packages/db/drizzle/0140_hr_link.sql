-- Slice 87 (INTG-014; integrations.md section 11.3; ADR-0126): the Thapsus-HR link's identifier
-- mapping, sync position and outbound delivery log. Expand-only: four new tables, a check on the
-- link's own integration_connection row, and the new permissions in existing tenants' built-in
-- roles. Behind the integrations.thapsus_hr flag, off by default.
CREATE TABLE "hr_delivery" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"kind" text NOT NULL,
	"harbour_ref" uuid NOT NULL,
	"hr_id" text,
	"idempotency_key" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hr_delivery_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hr_delivery_ref_key" UNIQUE("tenant_id","kind","harbour_ref"),
	CONSTRAINT "hr_delivery_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "hr_delivery_values" CHECK (kind IN ('starter', 'shift', 'clock_event', 'pay_units') AND state IN ('pending', 'sent', 'failed', 'refused')
        AND (hr_id IS NULL OR hr_id ~ '^[A-Za-z0-9_-]{1,64}$')
        AND (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,40}$')
        AND attempts >= 0
        AND ((state = 'sent') = (sent_at IS NOT NULL AND hr_id IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "hr_location_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"hr_location_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hr_location_link_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hr_location_link_hr_id" CHECK (hr_location_id ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "hr_person_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"hr_employee_id" text NOT NULL,
	"employee_number" text,
	"staff_profile_id" uuid,
	"state" text NOT NULL,
	"match_method" text,
	"review_reason" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"leaving_on" date,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hr_person_link_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hr_person_link_employee_key" UNIQUE("tenant_id","hr_employee_id"),
	CONSTRAINT "hr_person_link_values" CHECK (state IN ('linked', 'review', 'rejected')
        AND (match_method IS NULL OR match_method IN ('employee_number', 'email_and_birth_date', 'manual', 'starter'))
        AND (review_reason IS NULL OR review_reason IN ('conflict', 'ambiguous', 'already_linked', 'no_match'))
        AND hr_employee_id ~ '^[A-Za-z0-9_-]{1,64}$'
        AND (employee_number IS NULL OR employee_number ~ '^[A-Za-z0-9_/-]{1,40}$')),
	CONSTRAINT "hr_person_link_state" CHECK ((state <> 'linked' OR (staff_profile_id IS NOT NULL AND match_method IS NOT NULL AND review_reason IS NULL))
        AND (state <> 'review' OR (review_reason IS NOT NULL AND match_method IS NULL))
        AND (match_method IS DISTINCT FROM 'manual' OR confirmed_by IS NOT NULL)
        AND ((confirmed_by IS NULL) = (confirmed_at IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "hr_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"kind" text NOT NULL,
	"cursor" text,
	"last_good_sync_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hr_sync_state_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hr_sync_state_kind_key" UNIQUE("tenant_id","kind"),
	CONSTRAINT "hr_sync_state_values" CHECK (kind IN ('employees', 'locations', 'absences', 'rates')
        AND (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,40}$')
        AND (cursor IS NULL OR char_length(cursor) <= 512)
        AND failures >= 0)
);
--> statement-breakpoint
ALTER TABLE "hr_location_link" ADD CONSTRAINT "hr_location_link_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_person_link" ADD CONSTRAINT "hr_person_link_staff_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_person_link" ADD CONSTRAINT "hr_person_link_confirmed_by_fk" FOREIGN KEY ("tenant_id","confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "hr_delivery_due_idx" ON "hr_delivery" USING btree ("tenant_id","next_attempt_at") WHERE state IN ('pending', 'failed');
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_location_link_location_key" ON "hr_location_link" USING btree ("tenant_id","location_id") WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_location_link_hr_key" ON "hr_location_link" USING btree ("tenant_id","hr_location_id") WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_person_link_staff_key" ON "hr_person_link" USING btree ("tenant_id","staff_profile_id") WHERE state = 'linked' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX "hr_person_link_review_idx" ON "hr_person_link" USING btree ("tenant_id","state");
--> statement-breakpoint
-- Every table: forced RLS and the tenant policy. Holders of integrations.hr_link.read, .review or
-- .manage read them, as does the organisation's own system context (the sync); no DELETE.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_person_link', 'hr_location_link', 'hr_sync_state', 'hr_delivery'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY hr_link_read ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app, harbour_owner '
      'USING (app.is_system() OR app.holds_staff_permission(''integrations.hr_link.read'') '
      'OR app.holds_staff_permission(''integrations.hr_link.review'') '
      'OR app.holds_staff_permission(''integrations.hr_link.manage''))', t);
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  -- The sync position and the delivery log are written by the sync alone.
  FOREACH t IN ARRAY ARRAY['hr_sync_state', 'hr_delivery'] LOOP
    EXECUTE format(
      'CREATE POLICY hr_link_sync_insert ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app, harbour_owner '
      'WITH CHECK (app.is_system())', t);
    EXECUTE format(
      'CREATE POLICY hr_link_sync_update ON public.%I AS RESTRICTIVE FOR UPDATE TO harbour_app, harbour_owner '
      'USING (app.is_system()) WITH CHECK (app.is_system())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Locations are mapped by a holder of integrations.hr_link.manage, or by the sync.
CREATE POLICY hr_location_link_insert ON public.hr_location_link AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.is_system() OR app.holds_staff_permission('integrations.hr_link.manage'));
--> statement-breakpoint
CREATE POLICY hr_location_link_update ON public.hr_location_link AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.holds_staff_permission('integrations.hr_link.manage'))
  WITH CHECK (app.is_system() OR app.holds_staff_permission('integrations.hr_link.manage'));
--> statement-breakpoint
-- Rule 3: the sync proposes and makes automatic links; a person confirms or rejects with
-- integrations.hr_link.review.
CREATE POLICY hr_person_link_insert ON public.hr_person_link AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.is_system());
--> statement-breakpoint
CREATE POLICY hr_person_link_update ON public.hr_person_link AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.holds_staff_permission('integrations.hr_link.review'))
  WITH CHECK (app.is_system() OR app.holds_staff_permission('integrations.hr_link.review'));
--> statement-breakpoint
-- A person's decision on a match (HZ-133): only the state, the staff file and the confirmation
-- change; it is made in the reviewer's own name; a link is confirmed manually, never to the
-- reviewer's own staff file; Thapsus-HR's identifiers and the leaving date are the sync's alone.
CREATE OR REPLACE FUNCTION app.hr_person_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
BEGIN
  IF v_me IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.hr_employee_id, NEW.employee_number, NEW.leaving_on, NEW.last_seen_at,
      NEW.deleted_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.hr_employee_id, OLD.employee_number, OLD.leaving_on, OLD.last_seen_at,
      OLD.deleted_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'hr_link_sync_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.state = 'review' AND NEW.state = 'linked' AND NEW.match_method = 'manual')
          OR (OLD.state IN ('review', 'linked') AND NEW.state = 'rejected')) THEN
    RAISE EXCEPTION 'hr_link_decision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.confirmed_by IS DISTINCT FROM v_me OR NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'hr_link_not_you' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'linked' AND app.staff_profile_worker(NEW.staff_profile_id) = v_me THEN
    RAISE EXCEPTION 'hr_link_own_file' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hr_person_link_guard BEFORE UPDATE ON public.hr_person_link
  FOR EACH ROW EXECUTE FUNCTION app.hr_person_link_guard();
--> statement-breakpoint
-- Earlier versions are read as the rows are.
CREATE POLICY record_version_hr_link ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (table_name NOT IN ('hr_person_link', 'hr_location_link', 'hr_sync_state', 'hr_delivery')
    OR app.is_system()
    OR app.holds_staff_permission('integrations.hr_link.read')
    OR app.holds_staff_permission('integrations.hr_link.review')
    OR app.holds_staff_permission('integrations.hr_link.manage'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.hr_person_link, public.hr_location_link,
  public.hr_sync_state, public.hr_delivery TO harbour_app;
--> statement-breakpoint
-- Rule 1 (UK only), in the database as well: the link's connection row names a UK workspace on
-- the UK host over HTTPS, with no credentials or port in the URL. Only a holder of
-- integrations.hr_link.manage, or the sync, writes that row.
ALTER TABLE public.integration_connection ADD CONSTRAINT integration_connection_hr_link_uk CHECK (
  port <> 'integrations.hr_link' OR (
    provider IN ('thapsus_hr', 'mock')
    AND settings ->> 'homeRegion' = 'uk'
    AND settings ->> 'apiBaseUrl' ~ '^https://api\.uk\.[a-z0-9-]+(\.[a-z0-9-]+)+(/[A-Za-z0-9/_-]*)?$'
    AND status IN ('connected', 'disconnected')));
--> statement-breakpoint
CREATE POLICY integration_connection_hr_link_insert ON public.integration_connection AS RESTRICTIVE
  FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (port <> 'integrations.hr_link' OR app.is_system()
    OR app.holds_staff_permission('integrations.hr_link.manage'));
--> statement-breakpoint
CREATE POLICY integration_connection_hr_link_update ON public.integration_connection AS RESTRICTIVE
  FOR UPDATE TO harbour_app, harbour_owner
  USING (port <> 'integrations.hr_link' OR app.is_system()
    OR app.holds_staff_permission('integrations.hr_link.manage'))
  WITH CHECK (port <> 'integrations.hr_link' OR app.is_system()
    OR app.holds_staff_permission('integrations.hr_link.manage'));
--> statement-breakpoint
-- Data migration: existing tenants' copies of the built-in roles gain the link's permissions as
-- the built-in definitions (packages/domain/src/platform/roles.ts) now hold them. Each change is a
-- new version of the role, made in that tenant's context and audited. Idempotent.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['integrations.hr_link.manage', 'integrations.hr_link.review', 'integrations.hr_link.read']),
        ('registered_manager', ARRAY['integrations.hr_link.manage', 'integrations.hr_link.review', 'integrations.hr_link.read']),
        ('hr', ARRAY['integrations.hr_link.manage', 'integrations.hr_link.review', 'integrations.hr_link.read']),
        ('deputy_manager', ARRAY['integrations.hr_link.review', 'integrations.hr_link.read']),
        ('care_coordinator', ARRAY['integrations.hr_link.read'])
      ),
      targets AS (
        SELECT r.id, r.tenant_id, r.key,
          ARRAY(SELECT p FROM unnest(g.add) WITH ORDINALITY AS a(p, n)
                WHERE p <> ALL (r.permissions) ORDER BY n) AS missing
        FROM public.role r JOIN grants g ON g.key = r.key
        WHERE r.tenant_id = t AND r.is_builtin AND NOT (r.permissions @> g.add)
      ),
      changed AS (
        UPDATE public.role r SET permissions = r.permissions || x.missing
          FROM targets x WHERE r.id = x.id
          RETURNING r.id
      )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT x.tenant_id, 'system', ARRAY['system'], 'platform.role.permissions_migrated',
        'success', 'role', x.id::text,
        jsonb_build_object('migration', '0140_hr_link', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the HR platform link permissions their built-in definitions added (migration 0140)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
