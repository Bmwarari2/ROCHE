CREATE TABLE "clock_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"shift_id" uuid,
	"location_id" uuid NOT NULL,
	"device_time" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text,
	"evidence" text DEFAULT 'none' NOT NULL,
	"nfc_tag_ref" text,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "clock_event_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "clock_event_kind" CHECK (kind IN ('in', 'out', 'break_start', 'break_end')),
	CONSTRAINT "clock_event_evidence" CHECK (evidence IN ('none', 'at_location', 'nfc')),
	CONSTRAINT "clock_event_nfc" CHECK ((evidence = 'nfc') = (nfc_tag_ref IS NOT NULL) AND (nfc_tag_ref IS NULL OR char_length(nfc_tag_ref) BETWEEN 1 AND 120))
);
--> statement-breakpoint
CREATE TABLE "clock_setting" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"evidence" text DEFAULT 'none' NOT NULL,
	"nfc_tag_refs" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "clock_setting_location_key" UNIQUE("tenant_id","location_id"),
	CONSTRAINT "clock_setting_evidence" CHECK (evidence IN ('none', 'at_location', 'nfc'))
);
--> statement-breakpoint
CREATE TABLE "sleep_in_awake_period" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"timesheet_entry_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "sleep_in_awake_period_times" CHECK (ended_at > started_at)
);
--> statement-breakpoint
CREATE TABLE "timesheet_entry" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"shift_id" uuid,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"breaks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"travel" text,
	"mileage_tenths" integer,
	"source" text NOT NULL,
	"clock_in_id" uuid,
	"clock_out_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"supersedes_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "timesheet_entry_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "timesheet_entry_kind" CHECK (kind IN ('work', 'sleep_in', 'on_call_at_workplace', 'on_call_away', 'training', 'travel')),
	CONSTRAINT "timesheet_entry_travel" CHECK ((kind = 'travel') = (travel IS NOT NULL) AND (travel IS NULL OR travel IN ('between_assignments', 'home_to_first_assignment', 'last_assignment_to_home', 'commute_to_fixed_workplace'))),
	CONSTRAINT "timesheet_entry_mileage" CHECK (mileage_tenths IS NULL OR (kind = 'travel' AND mileage_tenths BETWEEN 0 AND 100000)),
	CONSTRAINT "timesheet_entry_times" CHECK (ended_at > started_at AND ended_at - started_at <= interval '25 hours'),
	CONSTRAINT "timesheet_entry_source" CHECK (source IN ('clock', 'manual')),
	CONSTRAINT "timesheet_entry_status" CHECK (status IN ('draft', 'approved')),
	CONSTRAINT "timesheet_entry_approved" CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL) AND (approved_by IS NULL OR approved_by <> worker_id)),
	CONSTRAINT "timesheet_entry_correction" CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL) AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500)),
	CONSTRAINT "timesheet_entry_breaks" CHECK (jsonb_typeof(breaks) = 'array')
);
--> statement-breakpoint
CREATE TABLE "working_time_opt_out" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"signed_on" date NOT NULL,
	"ends_on" date,
	"notice_amount" integer,
	"notice_unit" text,
	"notice_given_on" date,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "working_time_opt_out_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_time_opt_out_recorder" CHECK (recorded_by <> worker_id),
	CONSTRAINT "working_time_opt_out_ends" CHECK (ends_on IS NULL OR ends_on >= signed_on),
	CONSTRAINT "working_time_opt_out_notice" CHECK ((notice_amount IS NULL) = (notice_unit IS NULL) AND (notice_unit IS NULL OR (notice_unit IN ('days', 'months') AND notice_amount BETWEEN 0 AND 365))),
	CONSTRAINT "working_time_opt_out_notice_given" CHECK (notice_given_on IS NULL OR notice_given_on >= signed_on)
);
--> statement-breakpoint
CREATE TABLE "working_time_result" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"location_id" uuid,
	"evaluate_from" date NOT NULL,
	"evaluate_to" date NOT NULL,
	"findings" jsonb NOT NULL,
	"breaches" integer NOT NULL,
	"conditionals" integer NOT NULL,
	"input_hash" text NOT NULL,
	"trigger" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "working_time_result_range" CHECK (evaluate_to >= evaluate_from),
	CONSTRAINT "working_time_result_counts" CHECK (breaches >= 0 AND conditionals >= 0),
	CONSTRAINT "working_time_result_findings" CHECK (jsonb_typeof(findings) = 'array'),
	CONSTRAINT "working_time_result_trigger" CHECK (trigger IN ('timesheet_approved', 'requested'))
);
--> statement-breakpoint
ALTER TABLE "clock_event" ADD CONSTRAINT "clock_event_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_event" ADD CONSTRAINT "clock_event_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_event" ADD CONSTRAINT "clock_event_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shift"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_setting" ADD CONSTRAINT "clock_setting_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_in_awake_period" ADD CONSTRAINT "sleep_in_awake_period_entry_fk" FOREIGN KEY ("tenant_id","timesheet_entry_id") REFERENCES "public"."timesheet_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entry" ADD CONSTRAINT "timesheet_entry_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entry" ADD CONSTRAINT "timesheet_entry_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entry" ADD CONSTRAINT "timesheet_entry_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entry" ADD CONSTRAINT "timesheet_entry_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shift"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entry" ADD CONSTRAINT "timesheet_entry_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."timesheet_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_time_opt_out" ADD CONSTRAINT "working_time_opt_out_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_time_opt_out" ADD CONSTRAINT "working_time_opt_out_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_time_result" ADD CONSTRAINT "working_time_result_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_time_result" ADD CONSTRAINT "working_time_result_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clock_event_worker_idx" ON "clock_event" USING btree ("tenant_id","worker_id","device_time");--> statement-breakpoint
CREATE INDEX "clock_event_location_idx" ON "clock_event" USING btree ("tenant_id","location_id","device_time");--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_entry_one_correction_key" ON "timesheet_entry" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_entry_clock_out_key" ON "timesheet_entry" USING btree ("tenant_id","clock_out_id") WHERE clock_out_id IS NOT NULL AND supersedes_id IS NULL;--> statement-breakpoint
CREATE INDEX "timesheet_entry_worker_idx" ON "timesheet_entry" USING btree ("tenant_id","worker_id","started_at");--> statement-breakpoint
CREATE INDEX "timesheet_entry_location_idx" ON "timesheet_entry" USING btree ("tenant_id","location_id","started_at");--> statement-breakpoint
CREATE INDEX "working_time_opt_out_worker_idx" ON "working_time_opt_out" USING btree ("tenant_id","worker_id");--> statement-breakpoint
CREATE INDEX "working_time_result_worker_idx" ON "working_time_result" USING btree ("tenant_id","worker_id","evaluate_to");--> statement-breakpoint

-- Time and attendance and working-time records (scheduling.md section 16; SCHED-004, SCHED-003;
-- HZ-010, HZ-124, HZ-011).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clock_setting', 'clock_event', 'timesheet_entry', 'sleep_in_awake_period',
      'working_time_opt_out', 'working_time_result'] LOOP
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

-- Who reads a location's time records: those who build or approve its rota.
CREATE OR REPLACE FUNCTION app.reads_time_records(p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.is_system()
    OR app.holds_permission_at('scheduling.rota.manage', p_location_id)
    OR app.holds_permission_at('scheduling.rota.approve', p_location_id)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reads_time_records(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reads_time_records(uuid) TO harbour_app, harbour_owner;
--> statement-breakpoint

CREATE POLICY clock_setting_read ON public.clock_setting AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_rota(location_id));
--> statement-breakpoint
CREATE POLICY clock_setting_write ON public.clock_setting AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_at('scheduling.rota.approve', location_id));
--> statement-breakpoint
CREATE POLICY clock_setting_change ON public.clock_setting AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_permission_at('scheduling.rota.approve', location_id))
  WITH CHECK (app.holds_permission_at('scheduling.rota.approve', location_id));
--> statement-breakpoint

-- Clock events: the member's own, or those who build or approve the rota there. Written by the
-- member for themselves (with the self permission), or by the API as the system for an agency or
-- bank member's late upload (ADR-0088).
CREATE POLICY clock_event_read ON public.clock_event AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (worker_id = app.current_user_id() OR app.reads_time_records(location_id));
--> statement-breakpoint
CREATE POLICY clock_event_insert ON public.clock_event AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.is_system() OR (worker_id = app.current_user_id()
    AND app.holds_self_permission('scheduling.timesheet.self')));
--> statement-breakpoint

-- Timesheets: the member's own, or those who build or approve the rota there. A draft is made by
-- the system from the clock, or by a rota builder for someone else; changed by a rota builder or
-- approver, never by the worker.
CREATE POLICY timesheet_read ON public.timesheet_entry AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (worker_id = app.current_user_id() OR app.reads_time_records(location_id));
--> statement-breakpoint
CREATE POLICY timesheet_insert ON public.timesheet_entry AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.is_system() OR (app.reads_time_records(location_id)
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint
CREATE POLICY timesheet_update ON public.timesheet_entry AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.is_system() OR (app.reads_time_records(location_id)
    AND worker_id <> app.current_user_id()))
  WITH CHECK (app.is_system() OR (app.reads_time_records(location_id)
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint

-- An entry is made a draft; approved only by a holder of scheduling.rota.approve at its location
-- in their own name, never the worker; fixed once approved; who, where and what it corrects never
-- change; a correction is of an approved entry of the same worker.
CREATE OR REPLACE FUNCTION app.timesheet_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_target public.timesheet_entry%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A timesheet entry starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO v_target FROM public.timesheet_entry e
       WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.supersedes_id;
      IF NOT FOUND OR v_target.status <> 'approved' OR v_target.worker_id <> NEW.worker_id
         OR v_target.location_id <> NEW.location_id THEN
        RAISE EXCEPTION 'A correction is of an approved entry of the same worker and location'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'An approved entry is corrected by a new entry, never changed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.clock_in_id IS DISTINCT FROM OLD.clock_in_id
     OR NEW.clock_out_id IS DISTINCT FROM OLD.clock_out_id THEN
    RAISE EXCEPTION 'An entry keeps its worker, location, clock events and what it corrects'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.approved_by IS DISTINCT FROM app.current_user_id()
       OR NOT app.holds_permission_at('scheduling.rota.approve', NEW.location_id) THEN
      RAISE EXCEPTION 'An entry is approved in the approver''s own name by a holder of the approve permission'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER timesheet_entry_guard BEFORE INSERT OR UPDATE ON public.timesheet_entry
  FOR EACH ROW EXECUTE FUNCTION app.timesheet_entry_guard();
--> statement-breakpoint

-- Awake periods follow their entry; added while it is a draft.
CREATE OR REPLACE FUNCTION app.awake_period_entry_location(p_entry uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT e.location_id FROM public.timesheet_entry e WHERE e.id = p_entry
$$;
--> statement-breakpoint
CREATE POLICY awake_read ON public.sleep_in_awake_period AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.awake_period_entry_location(timesheet_entry_id) IS NOT NULL);
--> statement-breakpoint
CREATE POLICY awake_insert ON public.sleep_in_awake_period AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.reads_time_records(app.awake_period_entry_location(timesheet_entry_id))
    AND EXISTS (SELECT 1 FROM public.timesheet_entry e
      WHERE e.id = timesheet_entry_id AND e.status = 'draft' AND e.kind = 'sleep_in'
        AND e.worker_id <> app.current_user_id()));
--> statement-breakpoint

-- Opt-outs: the member's own, or approvers anywhere; recorded by an approver in their own name,
-- never by the worker.
CREATE POLICY opt_out_read ON public.working_time_opt_out AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (worker_id = app.current_user_id() OR app.is_system()
    OR app.holds_permission_anywhere('scheduling.rota.approve'));
--> statement-breakpoint
CREATE POLICY opt_out_insert ON public.working_time_opt_out AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_anywhere('scheduling.rota.approve')
    AND worker_id <> app.current_user_id() AND recorded_by = app.current_user_id());
--> statement-breakpoint
CREATE POLICY opt_out_update ON public.working_time_opt_out AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_permission_anywhere('scheduling.rota.approve')
    AND worker_id <> app.current_user_id())
  WITH CHECK (app.holds_permission_anywhere('scheduling.rota.approve')
    AND worker_id <> app.current_user_id() AND recorded_by = app.current_user_id());
--> statement-breakpoint
-- Results: the member's own, or those who read time records where they were made.
CREATE POLICY result_read ON public.working_time_result AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (worker_id = app.current_user_id() OR app.reads_time_records(location_id)
    OR app.holds_permission_anywhere('scheduling.rota.approve'));
--> statement-breakpoint
CREATE POLICY result_insert ON public.working_time_result AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.is_system() OR app.holds_permission_anywhere('scheduling.rota.approve'));
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clock_setting', 'timesheet_entry', 'working_time_opt_out'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['clock_event', 'sleep_in_awake_period', 'working_time_result'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.clock_setting, public.timesheet_entry,
  public.working_time_opt_out TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.clock_event, public.sleep_in_awake_period,
  public.working_time_result TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.clock_setting, public.timesheet_entry, public.working_time_opt_out
  FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.clock_event, public.sleep_in_awake_period,
  public.working_time_result FROM harbour_app;
--> statement-breakpoint
-- Earlier versions follow the tables' own read rules.
CREATE POLICY record_version_time ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('clock_setting', 'timesheet_entry', 'working_time_opt_out')
    OR (table_name = 'clock_setting' AND app.reads_rota((data->>'location_id')::uuid))
    OR (table_name = 'timesheet_entry' AND ((data->>'worker_id')::uuid = app.current_user_id()
      OR app.reads_time_records((data->>'location_id')::uuid)))
    OR (table_name = 'working_time_opt_out' AND ((data->>'worker_id')::uuid = app.current_user_id()
      OR app.holds_permission_anywhere('scheduling.rota.approve'))));
