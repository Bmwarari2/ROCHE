CREATE TABLE "roster_override" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"blocker_keys" text[] NOT NULL,
	"justification" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "roster_override_blockers" CHECK (cardinality(blocker_keys) >= 1 AND NOT ('right_to_work' = ANY (blocker_keys))),
	CONSTRAINT "roster_override_justification" CHECK (char_length(btrim(justification)) BETWEEN 10 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "rota" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "rota_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "rota_dates" CHECK (ends_on >= starts_on AND ends_on - starts_on < 42),
	CONSTRAINT "rota_state" CHECK (state IN ('draft', 'published')),
	CONSTRAINT "rota_published" CHECK ((state = 'published') = (published_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rota_publication" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"rota_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_shift_start" timestamp with time zone,
	"notice_minutes" integer,
	"shift_count" integer NOT NULL,
	"open_shift_count" integer NOT NULL,
	"override_count" integer NOT NULL,
	"working_time_breaches" integer NOT NULL,
	"working_time_conditionals" integer NOT NULL,
	"staffing" jsonb NOT NULL,
	"check_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "rota_publication_counts" CHECK (shift_count >= 0 AND open_shift_count >= 0 AND override_count >= 0 AND working_time_breaches >= 0 AND working_time_conditionals >= 0 AND (notice_minutes IS NULL OR notice_minutes >= 0)),
	CONSTRAINT "rota_publication_staffing" CHECK (jsonb_typeof(staffing) = 'array')
);
--> statement-breakpoint
CREATE TABLE "shift" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"rota_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"template_id" uuid,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"required_competences" text[] DEFAULT '{}' NOT NULL,
	"required_skills" text[] DEFAULT '{}' NOT NULL,
	"supervised" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"changed_after_publish_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "shift_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_label" CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
	CONSTRAINT "shift_kind" CHECK (kind IN ('work', 'sleep_in', 'on_call_at_workplace', 'on_call_away', 'training')),
	CONSTRAINT "shift_times" CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '25 hours' AND break_minutes >= 0),
	CONSTRAINT "shift_cancelled" CHECK ((deleted_at IS NULL) = (cancel_reason IS NULL) AND (cancel_reason IS NULL OR btrim(cancel_reason) <> ''))
);
--> statement-breakpoint
CREATE TABLE "shift_assignment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"shift_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"published_at" timestamp with time zone,
	"remove_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "shift_assignment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_assignment_removed" CHECK ((deleted_at IS NULL) = (remove_reason IS NULL) AND (remove_reason IS NULL OR btrim(remove_reason) <> ''))
);
--> statement-breakpoint
CREATE TABLE "shift_pattern" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cycle_days" integer NOT NULL,
	"entries" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "shift_pattern_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_pattern_name" CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
	CONSTRAINT "shift_pattern_cycle" CHECK (cycle_days BETWEEN 1 AND 56),
	CONSTRAINT "shift_pattern_entries" CHECK (jsonb_typeof(entries) = 'array')
);
--> statement-breakpoint
CREATE TABLE "shift_template" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"required_competences" text[] DEFAULT '{}' NOT NULL,
	"required_skills" text[] DEFAULT '{}' NOT NULL,
	"supervised" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "shift_template_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_template_name" CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
	CONSTRAINT "shift_template_kind" CHECK (kind IN ('work', 'sleep_in', 'on_call_at_workplace', 'on_call_away', 'training')),
	CONSTRAINT "shift_template_minutes" CHECK (start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 0 AND 1439 AND break_minutes >= 0)
);
--> statement-breakpoint
ALTER TABLE "roster_override" ADD CONSTRAINT "roster_override_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "public"."shift_assignment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_override" ADD CONSTRAINT "roster_override_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_override" ADD CONSTRAINT "roster_override_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rota" ADD CONSTRAINT "rota_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rota_publication" ADD CONSTRAINT "rota_publication_rota_fk" FOREIGN KEY ("tenant_id","rota_id") REFERENCES "public"."rota"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rota_publication" ADD CONSTRAINT "rota_publication_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rota_publication" ADD CONSTRAINT "rota_publication_published_by_fk" FOREIGN KEY ("tenant_id","published_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_rota_fk" FOREIGN KEY ("tenant_id","rota_id") REFERENCES "public"."rota"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."shift_template"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignment" ADD CONSTRAINT "shift_assignment_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shift"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignment" ADD CONSTRAINT "shift_assignment_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignment" ADD CONSTRAINT "shift_assignment_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_pattern" ADD CONSTRAINT "shift_pattern_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_template" ADD CONSTRAINT "shift_template_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_override_assignment_idx" ON "roster_override" USING btree ("tenant_id","assignment_id");--> statement-breakpoint
CREATE INDEX "rota_location_idx" ON "rota" USING btree ("tenant_id","location_id","starts_on");--> statement-breakpoint
CREATE INDEX "rota_publication_rota_idx" ON "rota_publication" USING btree ("tenant_id","rota_id");--> statement-breakpoint
CREATE INDEX "shift_rota_idx" ON "shift" USING btree ("tenant_id","rota_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_assignment_live_key" ON "shift_assignment" USING btree ("tenant_id","shift_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "shift_assignment_worker_idx" ON "shift_assignment" USING btree ("tenant_id","worker_id");--> statement-breakpoint

-- Rota builder (scheduling.md section 14; SCHED-001, SCHED-002; hazards HZ-123 and HZ-124).
-- Forced row-level security with the tenant policy on every table (ADR-0002).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_template', 'shift_pattern', 'rota', 'rota_publication', 'shift',
      'shift_assignment', 'roster_override'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Who reads and who builds a location's rota (scheduling.md section 3): scheduling.rota.read or
-- .manage where the rota is; building needs .manage there.
CREATE OR REPLACE FUNCTION app.reads_rota(p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.is_system()
    OR app.holds_permission_at('scheduling.rota.read', p_location_id)
    OR app.holds_permission_at('scheduling.rota.manage', p_location_id)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.manages_rota(p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.is_system() OR app.holds_permission_at('scheduling.rota.manage', p_location_id)
$$;
--> statement-breakpoint
-- A self permission (scheduling.timesheet.self) held through any role, whatever its scope: it is
-- about the member's own rows only, so a care worker's assigned-scope role gives it (as
-- app.holds_staff_permission does for workforce.self.read). Only permissions ending in `.self`.
CREATE OR REPLACE FUNCTION app.holds_self_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND p_permission LIKE '%.self' AND EXISTS (
    SELECT 1
    FROM public.role_assignment ra
    JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
    WHERE ra.tenant_id = app.current_tenant_id()
      AND ra.tenant_user_id = app.current_user_id()
      AND ra.deleted_at IS NULL
      AND r.archived_at IS NULL
      AND ra.valid_from <= now()
      AND (ra.valid_to IS NULL OR ra.valid_to > now())
      AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
        'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
      AND p_permission = ANY (r.permissions))
$$;
--> statement-breakpoint
-- A worker's own published shifts, read with scheduling.timesheet.self (invoker rights: the
-- assignment's own policies, which never refer back to shift).
CREATE OR REPLACE FUNCTION app.works_published_shift(p_shift_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL
    AND app.holds_self_permission('scheduling.timesheet.self')
    AND EXISTS (SELECT 1 FROM public.shift_assignment a
      WHERE a.tenant_id = app.current_tenant_id() AND a.shift_id = p_shift_id
        AND a.worker_id = app.current_user_id() AND a.deleted_at IS NULL
        AND a.published_at IS NOT NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reads_rota(uuid), app.manages_rota(uuid),
  app.works_published_shift(uuid), app.holds_self_permission(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reads_rota(uuid), app.manages_rota(uuid),
  app.works_published_shift(uuid), app.holds_self_permission(text) TO harbour_app, harbour_owner;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_template', 'shift_pattern', 'rota'] LOOP
    EXECUTE format('CREATE POLICY rota_read ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app '
      'USING (app.reads_rota(location_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['shift_template', 'shift_pattern', 'rota', 'shift', 'shift_assignment']
  LOOP
    EXECUTE format('CREATE POLICY rota_insert ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app '
      'WITH CHECK (app.manages_rota(location_id))', t);
    EXECUTE format('CREATE POLICY rota_update ON public.%I AS RESTRICTIVE FOR UPDATE TO harbour_app '
      'USING (app.manages_rota(location_id)) WITH CHECK (app.manages_rota(location_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY rota_read ON public.shift AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_rota(location_id)
    OR (published_at IS NOT NULL AND deleted_at IS NULL AND app.works_published_shift(id)));
--> statement-breakpoint
CREATE POLICY rota_read ON public.shift_assignment AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_rota(location_id)
    OR (worker_id = app.current_user_id() AND published_at IS NOT NULL AND deleted_at IS NULL
      AND app.holds_self_permission('scheduling.timesheet.self')));
--> statement-breakpoint
CREATE POLICY rota_read ON public.rota_publication AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_rota(location_id));
--> statement-breakpoint
-- A publication is recorded in the publisher's own name.
CREATE POLICY rota_publication_insert ON public.rota_publication AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR (app.manages_rota(location_id)
    AND published_by = app.current_user_id()));
--> statement-breakpoint
-- HZ-124: an override of the rostering rule is read by those who build or approve the rota there,
-- and given in the giver's own name by a holder of scheduling.rota.approve at the location, never
-- for themselves; a right to work is never overridden (the table's check) and the justification
-- is a sentence, not a tick.
CREATE POLICY roster_override_read ON public.roster_override AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.holds_permission_at('scheduling.rota.manage', location_id)
    OR app.holds_permission_at('scheduling.rota.approve', location_id));
--> statement-breakpoint
CREATE POLICY roster_override_insert ON public.roster_override AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.holds_permission_at('scheduling.rota.approve', location_id)
    AND created_by = app.current_user_id() AND worker_id <> app.current_user_id());
--> statement-breakpoint

-- Where a template, pattern or rota is never changes; a rota's dates never overlap another live
-- rota at the same location.
CREATE OR REPLACE FUNCTION app.rota_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'A rota, template or pattern keeps its location'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_TABLE_NAME = 'rota' THEN
    IF NEW.deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM public.rota r
      WHERE r.tenant_id = NEW.tenant_id AND r.location_id = NEW.location_id AND r.id <> NEW.id
        AND r.deleted_at IS NULL AND r.starts_on <= NEW.ends_on AND NEW.starts_on <= r.ends_on) THEN
      RAISE EXCEPTION 'Rotas at a location do not overlap' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_template', 'shift_pattern', 'rota'] LOOP
    EXECUTE format('CREATE TRIGGER rota_guard BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.rota_guard()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A shift belongs to a live rota at its own location and starts on one of the rota's UK dates; its
-- template, if any, is at the same location; its rota and location never change.
CREATE OR REPLACE FUNCTION app.shift_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rota public.rota%ROWTYPE;
  v_day date := (NEW.starts_at AT TIME ZONE 'Europe/London')::date;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.rota_id IS DISTINCT FROM OLD.rota_id
      OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
    RAISE EXCEPTION 'A shift keeps its rota and location'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO v_rota FROM public.rota r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.rota_id;
  IF NOT FOUND OR v_rota.deleted_at IS NOT NULL OR v_rota.location_id <> NEW.location_id THEN
    RAISE EXCEPTION 'A shift belongs to a live rota at its location'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_day < v_rota.starts_on OR v_day > v_rota.ends_on THEN
    RAISE EXCEPTION 'A shift starts on one of its rota''s dates' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.template_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.shift_template t
    WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.template_id
      AND t.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'A shift''s template is at its location'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER shift_guard BEFORE INSERT OR UPDATE ON public.shift
  FOR EACH ROW EXECUTE FUNCTION app.shift_guard();
--> statement-breakpoint

-- An assignment is to a live shift at the shift's location; its shift and worker never change; a
-- worker is never on two live shifts that overlap (as far as the writer can see; the API checks
-- every location with the system's rights first).
CREATE OR REPLACE FUNCTION app.shift_assignment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_shift public.shift%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.shift_id IS DISTINCT FROM OLD.shift_id
      OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
      OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
    RAISE EXCEPTION 'An assignment keeps its shift and worker'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_shift FROM public.shift s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shift_id;
  IF NOT FOUND OR v_shift.deleted_at IS NOT NULL OR v_shift.location_id <> NEW.location_id THEN
    RAISE EXCEPTION 'An assignment is to a live shift at its location'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shift_assignment a
    JOIN public.shift s ON s.tenant_id = a.tenant_id AND s.id = a.shift_id
    WHERE a.tenant_id = NEW.tenant_id AND a.worker_id = NEW.worker_id AND a.id <> NEW.id
      AND a.deleted_at IS NULL AND s.deleted_at IS NULL
      AND s.starts_at < v_shift.ends_at AND v_shift.starts_at < s.ends_at) THEN
    RAISE EXCEPTION 'A worker is not on two shifts at once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER shift_assignment_guard BEFORE INSERT OR UPDATE ON public.shift_assignment
  FOR EACH ROW EXECUTE FUNCTION app.shift_assignment_guard();
--> statement-breakpoint

-- HZ-124: an override is for a live assignment, at its location, about its worker.
CREATE OR REPLACE FUNCTION app.roster_override_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.shift_assignment a
    WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assignment_id AND a.deleted_at IS NULL
      AND a.location_id = NEW.location_id AND a.worker_id = NEW.worker_id) THEN
    RAISE EXCEPTION 'An override is for a live assignment of its worker at its location'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER roster_override_guard BEFORE INSERT ON public.roster_override
  FOR EACH ROW EXECUTE FUNCTION app.roster_override_guard();
--> statement-breakpoint

-- Mutable aggregates: version bump on every change, a record_version row, never deleted.
-- Publications and overrides are append-only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_template', 'shift_pattern', 'rota', 'shift', 'shift_assignment']
  LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['rota_publication', 'roster_override'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.shift_template, public.shift_pattern, public.rota,
  public.shift, public.shift_assignment TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.rota_publication, public.roster_override TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.shift_template, public.shift_pattern, public.rota, public.shift,
  public.shift_assignment FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.rota_publication, public.roster_override FROM harbour_app;
--> statement-breakpoint

-- Earlier versions of rota rows follow the rota's own read rule (record_version is otherwise
-- readable across the organisation; as migrations 0073 and 0079 did for their tables).
CREATE POLICY record_version_rota ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('shift_template', 'shift_pattern', 'rota', 'shift', 'shift_assignment')
    OR app.reads_rota((data->>'location_id')::uuid));
