CREATE TABLE "pay_profile" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"member_id" uuid NOT NULL,
	"frequency" text NOT NULL,
	"employment" text DEFAULT 'staff' NOT NULL,
	"role_key" text,
	"apprenticeship_started_on" date,
	"irregular_hours" boolean DEFAULT false NOT NULL,
	"leave_year_start" date,
	"qualifying_weekdays" integer[] DEFAULT '{}' NOT NULL,
	"ssp_average_weekly_earnings_pence" integer,
	"state_pension_age_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pay_profile_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pay_profile_member_key" UNIQUE("tenant_id","member_id"),
	CONSTRAINT "pay_profile_frequency" CHECK (frequency IN ('weekly', 'monthly')),
	CONSTRAINT "pay_profile_employment" CHECK (employment IN ('staff', 'bank', 'agency')),
	CONSTRAINT "pay_profile_role" CHECK (role_key IS NULL OR role_key ~ '^[a-z][a-z0-9_]{0,59}$'),
	CONSTRAINT "pay_profile_weekdays" CHECK (qualifying_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]),
	CONSTRAINT "pay_profile_earnings" CHECK (ssp_average_weekly_earnings_pence IS NULL OR ssp_average_weekly_earnings_pence BETWEEN 0 AND 10000000)
);
--> statement-breakpoint
CREATE TABLE "pay_rule_set" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"name" text NOT NULL,
	"version_number" integer NOT NULL,
	"effective_from" date NOT NULL,
	"role_rates" jsonb NOT NULL,
	"enhancements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stack_enhancements" boolean DEFAULT false NOT NULL,
	"sleep_in_flat_pence" integer DEFAULT 0 NOT NULL,
	"mileage_pence_per_mile" integer DEFAULT 0 NOT NULL,
	"on_call_flat_pence" integer DEFAULT 0 NOT NULL,
	"night_start_minute" integer,
	"night_end_minute" integer,
	"extra_bank_holidays" date[] DEFAULT '{}' NOT NULL,
	"overtime_after_minutes" integer,
	"rolled_up_holiday" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"contributor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pay_rule_set_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pay_rule_set_version_key" UNIQUE("tenant_id","version_number"),
	CONSTRAINT "pay_rule_set_status" CHECK (status IN ('draft', 'approved')),
	CONSTRAINT "pay_rule_set_version" CHECK (version_number >= 1),
	CONSTRAINT "pay_rule_set_name" CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
	CONSTRAINT "pay_rule_set_json" CHECK (jsonb_typeof(role_rates) = 'object' AND jsonb_typeof(enhancements) = 'array'),
	CONSTRAINT "pay_rule_set_amounts" CHECK (sleep_in_flat_pence >= 0 AND mileage_pence_per_mile >= 0 AND on_call_flat_pence >= 0
        AND (overtime_after_minutes IS NULL OR overtime_after_minutes >= 0)),
	CONSTRAINT "pay_rule_set_night" CHECK ((night_start_minute IS NULL) = (night_end_minute IS NULL)
        AND (night_start_minute IS NULL OR (night_start_minute BETWEEN 0 AND 1439
          AND night_end_minute BETWEEN 0 AND 1439 AND night_start_minute <> night_end_minute))),
	CONSTRAINT "pay_rule_set_approved" CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)
        AND (approved_by IS NULL OR NOT approved_by = ANY (contributor_ids)))
);
--> statement-breakpoint
CREATE TABLE "pay_run" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"frequency" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"kind" text DEFAULT 'regular' NOT NULL,
	"corrects_run_id" uuid,
	"rule_set_id" uuid NOT NULL,
	"nation" text NOT NULL,
	"rate_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculation" integer DEFAULT 0 NOT NULL,
	"calculated_at" timestamp with time zone,
	"calculated_by" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"locked_by" uuid,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pay_run_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pay_run_frequency" CHECK (frequency IN ('weekly', 'monthly')),
	CONSTRAINT "pay_run_kind" CHECK ((kind = 'correction') = (corrects_run_id IS NOT NULL) AND kind IN ('regular', 'correction')),
	CONSTRAINT "pay_run_period" CHECK (period_end >= period_start AND period_end - period_start <= 30),
	CONSTRAINT "pay_run_status" CHECK (status IN ('draft', 'locked')),
	CONSTRAINT "pay_run_nation" CHECK (nation IN ('england', 'wales', 'scotland', 'northern_ireland')),
	CONSTRAINT "pay_run_locked" CHECK ((status = 'locked') = (locked_by IS NOT NULL AND locked_at IS NOT NULL)
        AND (status = 'draft' OR calculation >= 1)),
	CONSTRAINT "pay_run_rate_rows" CHECK (jsonb_typeof(rate_rows) = 'array')
);
--> statement-breakpoint
CREATE TABLE "pay_run_exception" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"run_id" uuid NOT NULL,
	"calculation" integer NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" uuid,
	"line_input_hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"override_reason" text,
	"overridden_by" uuid,
	"overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pay_run_exception_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pay_run_exception_kind" CHECK (kind IN ('unapproved_timesheet', 'no_pay_profile', 'no_role_rate', 'no_date_of_birth', 'below_nmw', 'ssp_earnings_missing', 'no_qualifying_days', 'rate_missing')),
	CONSTRAINT "pay_run_exception_status" CHECK (status IN ('open', 'overridden')),
	CONSTRAINT "pay_run_exception_override" CHECK ((status = 'overridden') = (overridden_by IS NOT NULL AND overridden_at IS NOT NULL AND override_reason IS NOT NULL)
        AND (override_reason IS NULL OR char_length(btrim(override_reason)) BETWEEN 3 AND 500)
        AND (overridden_by IS NULL OR overridden_by <> member_id))
);
--> statement-breakpoint
CREATE TABLE "pay_run_line" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"run_id" uuid NOT NULL,
	"calculation" integer NOT NULL,
	"member_id" uuid NOT NULL,
	"paid_minutes" integer NOT NULL,
	"nmw_minutes" integer NOT NULL,
	"basic_pence" integer NOT NULL,
	"premium_pence" integer NOT NULL,
	"sleep_in_pence" integer NOT NULL,
	"on_call_pence" integer NOT NULL,
	"mileage_pence" integer NOT NULL,
	"nmw_top_up_pence" integer NOT NULL,
	"rolled_up_holiday_pence" integer NOT NULL,
	"ssp_pence" integer NOT NULL,
	"total_pence" integer NOT NULL,
	"difference_pence" integer,
	"holiday_accrued_minutes" integer,
	"nmw_band" text,
	"ae_category" text,
	"qualifying_earnings_pence" integer,
	"working" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "pay_run_line_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pay_run_line_member_key" UNIQUE("tenant_id","run_id","calculation","member_id"),
	CONSTRAINT "pay_run_line_calculation" CHECK (calculation >= 1),
	CONSTRAINT "pay_run_line_json" CHECK (jsonb_typeof(working) = 'array' AND jsonb_typeof(inputs) = 'object'),
	CONSTRAINT "pay_run_line_hash" CHECK (input_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pay_profile" ADD CONSTRAINT "pay_profile_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_rule_set" ADD CONSTRAINT "pay_rule_set_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run" ADD CONSTRAINT "pay_run_rule_set_fk" FOREIGN KEY ("tenant_id","rule_set_id") REFERENCES "public"."pay_rule_set"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run" ADD CONSTRAINT "pay_run_corrects_fk" FOREIGN KEY ("tenant_id","corrects_run_id") REFERENCES "public"."pay_run"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run" ADD CONSTRAINT "pay_run_calculated_by_fk" FOREIGN KEY ("tenant_id","calculated_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run" ADD CONSTRAINT "pay_run_locked_by_fk" FOREIGN KEY ("tenant_id","locked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_exception" ADD CONSTRAINT "pay_run_exception_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."pay_run"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_exception" ADD CONSTRAINT "pay_run_exception_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_exception" ADD CONSTRAINT "pay_run_exception_overridden_by_fk" FOREIGN KEY ("tenant_id","overridden_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_line" ADD CONSTRAINT "pay_run_line_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."pay_run"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_line" ADD CONSTRAINT "pay_run_line_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_rule_set_one_draft_key" ON "pay_rule_set" USING btree ("tenant_id") WHERE status = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "pay_run_one_regular_key" ON "pay_run" USING btree ("tenant_id","frequency","period_start") WHERE kind = 'regular';--> statement-breakpoint
CREATE UNIQUE INDEX "pay_run_one_open_correction_key" ON "pay_run" USING btree ("tenant_id","corrects_run_id") WHERE kind = 'correction' AND status = 'draft';--> statement-breakpoint
CREATE INDEX "pay_run_exception_run_idx" ON "pay_run_exception" USING btree ("tenant_id","run_id","calculation");--> statement-breakpoint
CREATE INDEX "pay_run_line_member_idx" ON "pay_run_line" USING btree ("tenant_id","member_id");--> statement-breakpoint

-- Pay calculation runs (scheduling.md section 18; SCHED-005, 006, 007; HZ-011).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pay_rule_set', 'pay_profile', 'pay_run', 'pay_run_line',
      'pay_run_exception'] LOOP
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

-- Rule 13: pay is the employer's, so a pay permission counts only when held for the whole
-- organisation: a tenant-wide role, or a role with no person scope (Finance). A location's manager
-- holds none here. Invoker rights: the member's own role rows.
CREATE OR REPLACE FUNCTION app.holds_pay_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND (
    app.holds_permission_at(p_permission, NULL)
    OR EXISTS (
      SELECT 1
      FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = app.current_tenant_id()
        AND ra.tenant_user_id = app.current_user_id()
        AND ra.deleted_at IS NULL
        AND r.archived_at IS NULL
        AND ra.valid_from <= now()
        AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND r.scope_kind::text = 'none'
        AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
          'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
        AND p_permission = ANY (r.permissions)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.holds_pay_permission(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_pay_permission(text) TO harbour_app, harbour_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reads_pay() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.is_system() OR app.holds_pay_permission('scheduling.pay.manage')
    OR app.holds_pay_permission('scheduling.pay.approve')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reads_pay() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reads_pay() TO harbour_app, harbour_owner;
--> statement-breakpoint
-- A run's state and whether the member has a line in it, read past the run's own policy (a member
-- sees their locked lines, never the run's other lines). Definer: owned by harbour_owner, whom the
-- restrictive policies below do not bind; the tenant still binds.
CREATE OR REPLACE FUNCTION app.pay_run_status(p_run uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.status FROM public.pay_run r
  WHERE r.tenant_id = app.current_tenant_id() AND r.id = p_run
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.pay_run_calculation(p_run uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.calculation FROM public.pay_run r
  WHERE r.tenant_id = app.current_tenant_id() AND r.id = p_run
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.has_locked_pay_line(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.pay_run r
    JOIN public.pay_run_line l ON l.tenant_id = r.tenant_id AND l.run_id = r.id
      AND l.calculation = r.calculation
    WHERE r.tenant_id = app.current_tenant_id() AND r.id = p_run AND r.status = 'locked'
      AND l.member_id = app.current_user_id())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.pay_run_status(uuid), app.pay_run_calculation(uuid),
  app.has_locked_pay_line(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.pay_run_status(uuid), app.pay_run_calculation(uuid),
  app.has_locked_pay_line(uuid) TO harbour_app, harbour_owner;
--> statement-breakpoint

-- Rule sets: read by pay holders; written by a holder of manage; approved by a holder of approve
-- (the guard checks who).
CREATE POLICY pay_rule_set_read ON public.pay_rule_set AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_pay());
--> statement-breakpoint
CREATE POLICY pay_rule_set_insert ON public.pay_rule_set AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_pay_permission('scheduling.pay.manage'));
--> statement-breakpoint
CREATE POLICY pay_rule_set_update ON public.pay_rule_set AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_pay_permission('scheduling.pay.manage')
    OR app.holds_pay_permission('scheduling.pay.approve'))
  WITH CHECK (app.holds_pay_permission('scheduling.pay.manage')
    OR app.holds_pay_permission('scheduling.pay.approve'));
--> statement-breakpoint

-- A draft is written by its author and changed by others, who are recorded; approved unchanged,
-- in their own name, by a holder of approve who neither wrote nor changed it; then fixed.
CREATE OR REPLACE FUNCTION app.pay_rule_set_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_me uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'A pay rule set starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    NEW.contributor_ids := CASE WHEN v_me IS NULL THEN '{}'::uuid[] ELSE ARRAY[v_me] END;
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'An approved pay rule set never changes: write a new version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NOT (OLD.contributor_ids <@ NEW.contributor_ids) OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A pay rule set keeps its version and contributors, and is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'approved' THEN
    IF (NEW.name, NEW.effective_from, NEW.role_rates, NEW.enhancements, NEW.stack_enhancements,
        NEW.sleep_in_flat_pence, NEW.mileage_pence_per_mile, NEW.on_call_flat_pence,
        NEW.night_start_minute, NEW.night_end_minute, NEW.extra_bank_holidays,
        NEW.overtime_after_minutes, NEW.rolled_up_holiday, NEW.contributor_ids)
       IS DISTINCT FROM
       (OLD.name, OLD.effective_from, OLD.role_rates, OLD.enhancements, OLD.stack_enhancements,
        OLD.sleep_in_flat_pence, OLD.mileage_pence_per_mile, OLD.on_call_flat_pence,
        OLD.night_start_minute, OLD.night_end_minute, OLD.extra_bank_holidays,
        OLD.overtime_after_minutes, OLD.rolled_up_holiday, OLD.contributor_ids)
       OR v_me IS NULL OR NEW.approved_by IS DISTINCT FROM v_me OR v_me = ANY (OLD.contributor_ids)
       OR NOT app.holds_pay_permission('scheduling.pay.approve') THEN
      RAISE EXCEPTION 'A pay rule set is approved unchanged, in their own name, by a holder of the approve permission who neither wrote nor changed it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT app.holds_pay_permission('scheduling.pay.manage') AND NOT app.is_system() THEN
    RAISE EXCEPTION 'A draft pay rule set is changed by a holder of the manage permission'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_me IS NOT NULL AND NOT (v_me = ANY (NEW.contributor_ids)) THEN
    NEW.contributor_ids := array_append(NEW.contributor_ids, v_me);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER pay_rule_set_guard BEFORE INSERT OR UPDATE ON public.pay_rule_set
  FOR EACH ROW EXECUTE FUNCTION app.pay_rule_set_guard();
--> statement-breakpoint

-- Pay profiles: the member reads their own; pay holders read all; a holder of manage writes
-- anyone's but their own.
CREATE POLICY pay_profile_read ON public.pay_profile AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (member_id = app.current_user_id() OR app.reads_pay());
--> statement-breakpoint
CREATE POLICY pay_profile_insert ON public.pay_profile AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_pay_permission('scheduling.pay.manage')
    AND member_id IS DISTINCT FROM app.current_user_id());
--> statement-breakpoint
CREATE POLICY pay_profile_update ON public.pay_profile AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_pay_permission('scheduling.pay.manage')
    AND member_id IS DISTINCT FROM app.current_user_id())
  WITH CHECK (app.holds_pay_permission('scheduling.pay.manage')
    AND member_id IS DISTINCT FROM app.current_user_id());
--> statement-breakpoint

-- Runs: pay holders; a member sees a locked run they have a line in. Drafted and calculated by a
-- holder of manage; locked by a holder of approve (the guard checks who).
CREATE POLICY pay_run_read ON public.pay_run AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_pay() OR app.has_locked_pay_line(id));
--> statement-breakpoint
CREATE POLICY pay_run_insert ON public.pay_run AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_pay_permission('scheduling.pay.manage'));
--> statement-breakpoint
CREATE POLICY pay_run_update ON public.pay_run AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_pay_permission('scheduling.pay.manage')
    OR app.holds_pay_permission('scheduling.pay.approve'))
  WITH CHECK (app.holds_pay_permission('scheduling.pay.manage')
    OR app.holds_pay_permission('scheduling.pay.approve'));
--> statement-breakpoint

-- A run starts a draft at calculation 0; a correction is of a locked run of the same period. A
-- draft is calculated by a holder of manage (the counter goes up by one); it is locked unchanged
-- by a holder of approve who neither created nor last calculated it, with no open exception in
-- its latest calculation. A locked run never changes.
CREATE OR REPLACE FUNCTION app.pay_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_target public.pay_run%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.calculation <> 0 OR NEW.locked_by IS NOT NULL
       OR NEW.locked_at IS NOT NULL OR NEW.calculated_by IS NOT NULL OR NEW.calculated_at IS NOT NULL THEN
      RAISE EXCEPTION 'A pay run starts as an uncalculated draft' USING ERRCODE = 'check_violation';
    END IF;
    -- Who created it is who inserts it: the lock check relies on it (security review L1).
    NEW.created_by := v_me;
    IF NOT EXISTS (SELECT 1 FROM public.pay_rule_set s WHERE s.tenant_id = NEW.tenant_id
                     AND s.id = NEW.rule_set_id AND s.status = 'approved') THEN
      RAISE EXCEPTION 'A pay run uses an approved pay rule set' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'correction' THEN
      SELECT * INTO v_target FROM public.pay_run r
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.corrects_run_id;
      IF NOT FOUND OR v_target.status <> 'locked' OR v_target.kind <> 'regular'
         OR v_target.frequency <> NEW.frequency OR v_target.period_start <> NEW.period_start
         OR v_target.period_end <> NEW.period_end THEN
        RAISE EXCEPTION 'A correction is of a locked regular run of the same period'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'A locked pay run never changes: correct it in a later run'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.frequency, NEW.period_start, NEW.period_end, NEW.kind, NEW.corrects_run_id,
      NEW.created_by, NEW.deleted_at)
     IS DISTINCT FROM (OLD.frequency, OLD.period_start, OLD.period_end, OLD.kind,
      OLD.corrects_run_id, OLD.created_by, NULL::timestamptz) THEN
    RAISE EXCEPTION 'A pay run keeps its period, kind and creator, and is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'locked' THEN
    IF (NEW.calculation, NEW.rule_set_id, NEW.nation, NEW.rate_rows, NEW.calculated_by)
       IS DISTINCT FROM (OLD.calculation, OLD.rule_set_id, OLD.nation, OLD.rate_rows,
         OLD.calculated_by)
       OR OLD.calculation < 1 OR v_me IS NULL OR NEW.locked_by IS DISTINCT FROM v_me
       OR v_me IS NOT DISTINCT FROM OLD.created_by OR v_me IS NOT DISTINCT FROM OLD.calculated_by
       OR NOT app.holds_pay_permission('scheduling.pay.approve') THEN
      RAISE EXCEPTION 'A pay run is checked and locked unchanged, in their own name, by a holder of the approve permission who neither created nor calculated it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pay_run_exception e
               WHERE e.tenant_id = OLD.tenant_id AND e.run_id = OLD.id
                 AND e.calculation = OLD.calculation AND e.status = 'open') THEN
      RAISE EXCEPTION 'A pay run with an open exception cannot be locked'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.calculation <> OLD.calculation THEN
    IF NEW.calculation <> OLD.calculation + 1 OR NEW.calculated_by IS DISTINCT FROM v_me
       OR NOT app.holds_pay_permission('scheduling.pay.manage') THEN
      RAISE EXCEPTION 'A pay run is calculated by a holder of the manage permission, in their own name'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF (NEW.rule_set_id, NEW.nation, NEW.rate_rows, NEW.calculated_by, NEW.calculated_at)
        IS DISTINCT FROM (OLD.rule_set_id, OLD.nation, OLD.rate_rows, OLD.calculated_by,
          OLD.calculated_at) THEN
    RAISE EXCEPTION 'A pay run''s rule set and rates change only with a calculation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER pay_run_guard BEFORE INSERT OR UPDATE ON public.pay_run
  FOR EACH ROW EXECUTE FUNCTION app.pay_run_guard();
--> statement-breakpoint

-- Lines: pay holders; the member reads their own in a locked run. Written only for a draft's
-- latest calculation, by a holder of manage; never changed.
CREATE POLICY pay_run_line_read ON public.pay_run_line AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_pay() OR (member_id = app.current_user_id()
    AND app.pay_run_status(run_id) = 'locked'
    AND calculation = app.pay_run_calculation(run_id)));
--> statement-breakpoint
CREATE POLICY pay_run_line_insert ON public.pay_run_line AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_pay_permission('scheduling.pay.manage')
    AND app.pay_run_status(run_id) = 'draft'
    AND calculation = app.pay_run_calculation(run_id));
--> statement-breakpoint

-- Exceptions: pay holders. Written for a draft's latest calculation by a holder of manage;
-- overridden with a reason by a holder of approve, in their own name, never on their own line,
-- while the run is a draft; nothing else changes.
CREATE POLICY pay_run_exception_read ON public.pay_run_exception AS RESTRICTIVE FOR SELECT
  TO harbour_app USING (app.reads_pay());
--> statement-breakpoint
CREATE POLICY pay_run_exception_insert ON public.pay_run_exception AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.holds_pay_permission('scheduling.pay.manage')
    AND app.pay_run_status(run_id) = 'draft'
    AND calculation = app.pay_run_calculation(run_id));
--> statement-breakpoint
CREATE POLICY pay_run_exception_update ON public.pay_run_exception AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.holds_pay_permission('scheduling.pay.approve')
    AND member_id IS DISTINCT FROM app.current_user_id())
  WITH CHECK (app.holds_pay_permission('scheduling.pay.approve')
    AND member_id IS DISTINCT FROM app.current_user_id());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.pay_run_exception_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_me uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- An override carries to a recalculation only while the line's inputs are unchanged (rule 9).
    IF NEW.status <> 'open' AND NOT EXISTS (
         SELECT 1 FROM public.pay_run_exception e
         WHERE e.tenant_id = NEW.tenant_id AND e.run_id = NEW.run_id
           AND e.calculation = NEW.calculation - 1 AND e.member_id = NEW.member_id
           AND e.kind = NEW.kind AND e.ref IS NOT DISTINCT FROM NEW.ref
           AND e.line_input_hash = NEW.line_input_hash AND e.status = 'overridden'
           AND e.overridden_by IS NOT DISTINCT FROM NEW.overridden_by
           AND e.override_reason IS NOT DISTINCT FROM NEW.override_reason) THEN
      RAISE EXCEPTION 'An exception starts open, unless carried from an override of the same inputs'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Its hash is the line's, when the line is written (they share a calculation).
    IF EXISTS (SELECT 1 FROM public.pay_run_line l
               WHERE l.tenant_id = NEW.tenant_id AND l.run_id = NEW.run_id
                 AND l.calculation = NEW.calculation AND l.member_id = NEW.member_id
                 AND l.input_hash <> NEW.line_input_hash) THEN
      RAISE EXCEPTION 'An exception carries its line''s input hash' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' OR NEW.status <> 'overridden'
     OR (NEW.run_id, NEW.calculation, NEW.member_id, NEW.kind, NEW.ref, NEW.line_input_hash,
         NEW.created_by, NEW.deleted_at)
        IS DISTINCT FROM (OLD.run_id, OLD.calculation, OLD.member_id, OLD.kind, OLD.ref,
          OLD.line_input_hash, OLD.created_by, NULL::timestamptz)
     OR app.pay_run_status(OLD.run_id) IS DISTINCT FROM 'draft'
     OR OLD.calculation IS DISTINCT FROM app.pay_run_calculation(OLD.run_id) THEN
    RAISE EXCEPTION 'An open exception of a draft''s latest calculation is overridden once, and nothing else changes'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.overridden_at := now();
  IF v_me IS NULL OR NEW.overridden_by IS DISTINCT FROM v_me OR v_me = OLD.member_id THEN
    RAISE EXCEPTION 'An exception is overridden in the approver''s own name, never on their own line'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER pay_run_exception_guard BEFORE INSERT OR UPDATE ON public.pay_run_exception
  FOR EACH ROW EXECUTE FUNCTION app.pay_run_exception_guard();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pay_rule_set', 'pay_profile', 'pay_run', 'pay_run_exception'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  EXECUTE 'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.pay_run_line '
    'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()';
  EXECUTE 'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.pay_run_line '
    'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()';
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.pay_rule_set, public.pay_profile, public.pay_run,
  public.pay_run_exception TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.pay_run_line TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.pay_rule_set, public.pay_profile, public.pay_run,
  public.pay_run_exception FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.pay_run_line FROM harbour_app;
--> statement-breakpoint
-- Earlier versions follow the tables' own read rules: pay holders only (a member's own profile too).
CREATE POLICY record_version_pay ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('pay_rule_set', 'pay_profile', 'pay_run', 'pay_run_exception')
    OR app.reads_pay()
    OR (table_name = 'pay_profile' AND (data->>'member_id')::uuid = app.current_user_id()));
--> statement-breakpoint
-- Earlier versions of opt-outs follow the opt-out table's own read rule (approvers of the member's
-- time, migration 0109's reads_worker_time), not approvers anywhere. Replaces 0109's policy here,
-- so a database that applied 0109 gets it too (security review L7).
DROP POLICY record_version_time ON public.record_version;
--> statement-breakpoint
CREATE POLICY record_version_time ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('clock_setting', 'timesheet_entry', 'working_time_opt_out')
    OR (table_name = 'clock_setting' AND app.reads_rota((data->>'location_id')::uuid))
    OR (table_name = 'timesheet_entry' AND ((data->>'worker_id')::uuid = app.current_user_id()
      OR app.reads_time_records((data->>'location_id')::uuid)))
    OR (table_name = 'working_time_opt_out' AND ((data->>'worker_id')::uuid = app.current_user_id()
      OR app.reads_worker_time((data->>'worker_id')::uuid))));
