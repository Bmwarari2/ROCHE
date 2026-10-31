CREATE TABLE "care_certificate_progress" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"standard_id" text NOT NULL,
	"knowledge_assessed_on" date NOT NULL,
	"knowledge_assessed_by" uuid NOT NULL,
	"observed_on" date,
	"observed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "care_certificate_progress_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "care_certificate_progress_standard_key" UNIQUE("tenant_id","staff_profile_id","standard_id"),
	CONSTRAINT "care_certificate_progress_standard" CHECK (standard_id IN ('cc01', 'cc02', 'cc03', 'cc04', 'cc05', 'cc06', 'cc07', 'cc08', 'cc09', 'cc10', 'cc11', 'cc12', 'cc13', 'cc14', 'cc15', 'cc16')),
	CONSTRAINT "care_certificate_progress_observed" CHECK ((observed_on IS NULL) = (observed_by IS NULL)
        AND (observed_on IS NULL OR observed_on >= knowledge_assessed_on))
);
--> statement-breakpoint
CREATE TABLE "induction_plan" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"care_certificate_held" boolean DEFAULT false NOT NULL,
	"probation_ends_on" date,
	"probation_outcome" text,
	"probation_decided_on" date,
	"probation_decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "induction_plan_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "induction_plan_profile_key" UNIQUE("tenant_id","staff_profile_id"),
	CONSTRAINT "induction_plan_probation" CHECK ((probation_outcome IS NULL) = (probation_decided_on IS NULL)
        AND (probation_outcome IS NULL) = (probation_decided_by IS NULL)
        AND (probation_outcome IS NULL OR (probation_outcome IN ('passed', 'extended', 'not_passed') AND probation_ends_on IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "leaver_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"leaving_on" date NOT NULL,
	"reason" text NOT NULL,
	"access_removed_at" timestamp with time zone,
	"access_removed_by" uuid,
	"exit_interview" text DEFAULT 'not_offered' NOT NULL,
	"exit_interview_on" date,
	"exit_interview_summary" text,
	"staff_file_retain_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "leaver_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "leaver_record_profile_key" UNIQUE("tenant_id","staff_profile_id"),
	CONSTRAINT "leaver_record_reason" CHECK (reason IN ('resignation', 'end_of_fixed_term', 'retirement', 'dismissal', 'redundancy', 'tupe_transfer_out', 'death_in_service', 'other')),
	CONSTRAINT "leaver_record_exit_interview" CHECK (exit_interview IN ('not_offered', 'offered', 'declined', 'held')
        AND (exit_interview_on IS NULL) = (exit_interview <> 'held')
        AND (exit_interview_summary IS NULL OR (exit_interview = 'held' AND length(btrim(exit_interview_summary)) BETWEEN 1 AND 4000))),
	CONSTRAINT "leaver_record_access" CHECK (access_removed_by IS NULL OR access_removed_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "probation_review" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"review_on" date NOT NULL,
	"reviewer_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"outcome" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "probation_review_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "probation_review_outcome" CHECK (outcome IN ('on_track', 'concerns')),
	CONSTRAINT "probation_review_notes" CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "reference_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"requested_on" date NOT NULL,
	"requester" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"sent_on" date,
	"sent_by" uuid,
	"declined_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "reference_request_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reference_request_requester" CHECK (length(btrim(requester)) BETWEEN 2 AND 200),
	CONSTRAINT "reference_request_kind" CHECK (kind IN ('factual', 'conduct')),
	CONSTRAINT "reference_request_state" CHECK (state IN ('requested', 'sent', 'declined')
        AND (state = 'sent') = (sent_on IS NOT NULL AND sent_by IS NOT NULL)
        AND (state = 'declined') = (declined_reason IS NOT NULL)
        AND (declined_reason IS NULL OR declined_reason IN ('no_consent_to_share', 'not_employed_here', 'duplicate_request')))
);
--> statement-breakpoint
CREATE TABLE "shadow_shift" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"shift_on" date NOT NULL,
	"location_id" uuid,
	"shadowed_id" uuid NOT NULL,
	"recorded_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "shadow_shift_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "staff_checklist_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"checklist" text NOT NULL,
	"kind" text NOT NULL,
	"done_on" date NOT NULL,
	"done_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "staff_checklist_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_checklist_item_once_key" UNIQUE("tenant_id","staff_profile_id","checklist","kind"),
	CONSTRAINT "staff_checklist_item_kind" CHECK ((checklist = 'induction' AND kind IN ('contract_issued', 'system_access_set_up', 'uniform_and_badge', 'location_induction', 'fire_safety_briefing', 'shadowing_signed_off'))
        OR (checklist = 'leaving' AND kind IN ('property_returned', 'final_pay_notified')))
);
--> statement-breakpoint
ALTER TABLE "care_certificate_progress" ADD CONSTRAINT "care_certificate_progress_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_certificate_progress" ADD CONSTRAINT "care_certificate_progress_assessor_fk" FOREIGN KEY ("tenant_id","knowledge_assessed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_certificate_progress" ADD CONSTRAINT "care_certificate_progress_observer_fk" FOREIGN KEY ("tenant_id","observed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "induction_plan" ADD CONSTRAINT "induction_plan_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "induction_plan" ADD CONSTRAINT "induction_plan_decided_by_fk" FOREIGN KEY ("tenant_id","probation_decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaver_record" ADD CONSTRAINT "leaver_record_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaver_record" ADD CONSTRAINT "leaver_record_removed_by_fk" FOREIGN KEY ("tenant_id","access_removed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probation_review" ADD CONSTRAINT "probation_review_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probation_review" ADD CONSTRAINT "probation_review_reviewer_fk" FOREIGN KEY ("tenant_id","reviewer_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_request" ADD CONSTRAINT "reference_request_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_request" ADD CONSTRAINT "reference_request_sent_by_fk" FOREIGN KEY ("tenant_id","sent_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_shift" ADD CONSTRAINT "shadow_shift_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_shift" ADD CONSTRAINT "shadow_shift_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_shift" ADD CONSTRAINT "shadow_shift_shadowed_fk" FOREIGN KEY ("tenant_id","shadowed_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_shift" ADD CONSTRAINT "shadow_shift_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_checklist_item" ADD CONSTRAINT "staff_checklist_item_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_checklist_item" ADD CONSTRAINT "staff_checklist_item_done_by_fk" FOREIGN KEY ("tenant_id","done_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "probation_review_profile_idx" ON "probation_review" USING btree ("tenant_id","staff_profile_id");--> statement-breakpoint
CREATE INDEX "reference_request_profile_idx" ON "reference_request" USING btree ("tenant_id","staff_profile_id");--> statement-breakpoint
CREATE INDEX "shadow_shift_profile_idx" ON "shadow_shift" USING btree ("tenant_id","staff_profile_id");--> statement-breakpoint

-- Induction, the Care Certificate and leavers (Phase 2 slice 29; WORK-004, WORK-013;
-- workforce.md section 2d). Forced RLS. Every row belongs to a staff profile and follows the
-- staff file: read by holders of workforce.staff_file.read or .manage (organisation-wide, as
-- app.holds_staff_permission counts them) and by the worker with workforce.self.read; written by
-- holders of workforce.staff_file.manage, never on their own file. Care Certificate progress is
-- also read and written by holders of workforce.competence.observe (assessors), never their own.

-- The member a staff profile is about, whoever asks (a definer: an assessor cannot read staff
-- profiles, yet must not assess themselves). Answers only for the session's organisation.
CREATE OR REPLACE FUNCTION app.staff_profile_worker(p_profile_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.tenant_user_id FROM public.staff_profile p
   WHERE p.tenant_id = app.current_tenant_id() AND p.id = p_profile_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.staff_profile_worker(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.staff_profile_worker(uuid) TO harbour_app;
--> statement-breakpoint
-- Writing on someone else's file with the staff file's manage permission.
CREATE OR REPLACE FUNCTION app.manages_staff_file_of(p_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL
    AND app.holds_staff_permission('workforce.staff_file.manage')
    AND app.staff_profile_worker(p_profile_id) IS DISTINCT FROM app.current_user_id()
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['induction_plan', 'staff_checklist_item', 'shadow_shift',
    'probation_review', 'care_certificate_progress', 'leaver_record', 'reference_request'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    IF t <> 'care_certificate_progress' THEN
      -- Read as the staff file is (app.staff_profile_member is invoker: null when hidden).
      EXECUTE format(
        'CREATE POLICY staff_file_read ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app '
        'USING (app.is_system() OR app.staff_profile_member(staff_profile_id) IS NOT NULL)', t);
      EXECUTE format(
        'CREATE POLICY staff_file_write ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app '
        'WITH CHECK (app.is_system() OR app.manages_staff_file_of(staff_profile_id))', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['induction_plan', 'leaver_record', 'reference_request'] LOOP
    EXECUTE format(
      'CREATE POLICY staff_file_change ON public.%I AS RESTRICTIVE FOR UPDATE TO harbour_app '
      'USING (app.is_system() OR app.manages_staff_file_of(staff_profile_id)) '
      'WITH CHECK (app.is_system() OR app.manages_staff_file_of(staff_profile_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- The Care Certificate: also assessors' (rule 20), never on their own file.
CREATE POLICY care_certificate_read ON public.care_certificate_progress AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.staff_profile_member(staff_profile_id) IS NOT NULL
    OR app.holds_staff_permission('workforce.competence.observe'));
--> statement-breakpoint
CREATE POLICY care_certificate_assess ON public.care_certificate_progress AS RESTRICTIVE FOR INSERT
  TO harbour_app WITH CHECK (app.is_system()
    OR ((app.holds_staff_permission('workforce.staff_file.manage')
         OR app.holds_staff_permission('workforce.competence.observe'))
        AND app.staff_profile_worker(staff_profile_id) IS DISTINCT FROM app.current_user_id()));
--> statement-breakpoint
CREATE POLICY care_certificate_observe ON public.care_certificate_progress AS RESTRICTIVE FOR UPDATE
  TO harbour_app USING (app.is_system()
    OR ((app.holds_staff_permission('workforce.staff_file.manage')
         OR app.holds_staff_permission('workforce.competence.observe'))
        AND app.staff_profile_worker(staff_profile_id) IS DISTINCT FROM app.current_user_id()))
  WITH CHECK (app.is_system()
    OR ((app.holds_staff_permission('workforce.staff_file.manage')
         OR app.holds_staff_permission('workforce.competence.observe'))
        AND app.staff_profile_worker(staff_profile_id) IS DISTINCT FROM app.current_user_id()));
--> statement-breakpoint
-- Earlier versions follow the staff file's read rule (as migration 0073 does for the file).
CREATE POLICY record_version_induction ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('induction_plan', 'care_certificate_progress', 'leaver_record',
                            'reference_request')
    OR app.is_system()
    OR app.holds_staff_permission('workforce.staff_file.read')
    OR app.holds_staff_permission('workforce.staff_file.manage'));
--> statement-breakpoint
-- Who did what is always the session's own member, never the worker (rules 19 to 22).
CREATE OR REPLACE FUNCTION app.induction_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_row jsonb := to_jsonb(NEW);
BEGIN
  IF v_me IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'staff_checklist_item' THEN
    IF (v_row ->> 'done_by')::uuid IS DISTINCT FROM v_me THEN
      RAISE EXCEPTION 'A checklist item is ticked in the ticker''s own name'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'shadow_shift' THEN
    IF (v_row ->> 'recorded_by')::uuid IS DISTINCT FROM v_me
       OR (v_row ->> 'shadowed_id')::uuid = app.staff_profile_worker(NEW.staff_profile_id) THEN
      RAISE EXCEPTION 'A shadow shift is recorded in one''s own name, shadowing someone else'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'probation_review' THEN
    IF (v_row ->> 'reviewer_id')::uuid IS DISTINCT FROM v_me THEN
      RAISE EXCEPTION 'A probation review is recorded in the reviewer''s own name'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_checklist_item', 'shadow_shift', 'probation_review'] LOOP
    EXECUTE format('CREATE TRIGGER induction_entry_guard BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.induction_entry_guard()', t);
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['induction_plan', 'care_certificate_progress', 'leaver_record',
                           'reference_request'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Probation (rule 21): the plan keeps its profile; a decision is the decider's own, and once
-- passed or not passed it stays.
CREATE OR REPLACE FUNCTION app.induction_plan_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.staff_profile_id IS DISTINCT FROM OLD.staff_profile_id THEN
    RAISE EXCEPTION 'An induction plan keeps its staff profile'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.probation_outcome IN ('passed', 'not_passed')
     AND (NEW.probation_outcome, NEW.probation_decided_on, NEW.probation_decided_by,
          NEW.probation_ends_on)
         IS DISTINCT FROM (OLD.probation_outcome, OLD.probation_decided_on,
                           OLD.probation_decided_by, OLD.probation_ends_on) THEN
    RAISE EXCEPTION 'A probation passed or not passed is decided'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF app.current_user_id() IS NOT NULL
     AND NEW.probation_decided_by IS DISTINCT FROM OLD.probation_decided_by
     AND NEW.probation_decided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A probation decision is the decider''s own'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER induction_plan_guard BEFORE UPDATE ON public.induction_plan
  FOR EACH ROW EXECUTE FUNCTION app.induction_plan_guard();
--> statement-breakpoint
-- The Care Certificate (rule 20): knowledge assessed and observed each in the assessor's own
-- name; the observation only by a holder of workforce.competence.observe; once recorded, never
-- changed.
CREATE OR REPLACE FUNCTION app.care_certificate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.staff_profile_id, NEW.standard_id, NEW.knowledge_assessed_on,
        NEW.knowledge_assessed_by, NEW.deleted_at)
       IS DISTINCT FROM
       (OLD.staff_profile_id, OLD.standard_id, OLD.knowledge_assessed_on,
        OLD.knowledge_assessed_by, OLD.deleted_at)
       OR OLD.observed_on IS NOT NULL THEN
      RAISE EXCEPTION 'A standard''s assessment and observation, once recorded, stay'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF v_me IS NOT NULL AND NEW.knowledge_assessed_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'Knowledge is assessed in the assessor''s own name'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.observed_on IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.observed_on IS NULL)
     AND v_me IS NOT NULL
     AND (NEW.observed_by IS DISTINCT FROM v_me
          OR NOT app.holds_staff_permission('workforce.competence.observe')) THEN
    RAISE EXCEPTION 'An observation is signed in the observer''s own name, by a holder of workforce.competence.observe'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER care_certificate_guard BEFORE INSERT OR UPDATE ON public.care_certificate_progress
  FOR EACH ROW EXECUTE FUNCTION app.care_certificate_guard();
--> statement-breakpoint
-- Leaving (rule 22): a leaver record keeps its profile and date; access, once ended, stays
-- ended; the exit interview only moves forward.
CREATE OR REPLACE FUNCTION app.leaver_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.staff_profile_id, NEW.leaving_on, NEW.reason, NEW.deleted_at)
     IS DISTINCT FROM (OLD.staff_profile_id, OLD.leaving_on, OLD.reason, OLD.deleted_at)
     AND app.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'A leaving keeps its member, date and reason'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.access_removed_at IS NOT NULL
     AND (NEW.access_removed_at, NEW.access_removed_by)
         IS DISTINCT FROM (OLD.access_removed_at, OLD.access_removed_by) THEN
    RAISE EXCEPTION 'Access, once ended, stays ended'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.exit_interview IS DISTINCT FROM OLD.exit_interview AND NOT (
       (OLD.exit_interview = 'not_offered' AND NEW.exit_interview IN ('offered', 'declined', 'held'))
       OR (OLD.exit_interview = 'offered' AND NEW.exit_interview IN ('declined', 'held'))) THEN
    RAISE EXCEPTION 'The exit interview only moves forward'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.exit_interview IN ('declined', 'held')
     AND (NEW.exit_interview_on, NEW.exit_interview_summary)
         IS DISTINCT FROM (OLD.exit_interview_on, OLD.exit_interview_summary) THEN
    RAISE EXCEPTION 'A held exit interview is recorded once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER leaver_record_guard BEFORE UPDATE ON public.leaver_record
  FOR EACH ROW EXECUTE FUNCTION app.leaver_record_guard();
--> statement-breakpoint
-- References (rule 22): answered once, in the sender's own name.
CREATE OR REPLACE FUNCTION app.reference_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.staff_profile_id, NEW.requested_on, NEW.requester, NEW.kind)
     IS DISTINCT FROM (OLD.staff_profile_id, OLD.requested_on, OLD.requester, OLD.kind)
     OR (OLD.state <> 'requested' AND NEW.state IS DISTINCT FROM OLD.state)
     OR (OLD.state <> 'requested' AND (NEW.sent_on, NEW.sent_by, NEW.declined_reason)
         IS DISTINCT FROM (OLD.sent_on, OLD.sent_by, OLD.declined_reason)) THEN
    RAISE EXCEPTION 'A reference request keeps its details and is answered once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF app.current_user_id() IS NOT NULL AND NEW.state = 'sent'
     AND NEW.sent_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A reference is sent in the sender''s own name'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER reference_request_guard BEFORE UPDATE ON public.reference_request
  FOR EACH ROW EXECUTE FUNCTION app.reference_request_guard();
--> statement-breakpoint
-- Read-and-sign at induction (rule 19): for one staff profile, how many published policies the
-- worker's roles need, and how many they have signed (on the version in force, or on the one a
-- minor change superseded; quality.md rule 26). Counts only, never which policy or when, and only
-- to the worker or a reader of their staff file: signatures are otherwise read only by policy
-- managers (migration 0087).
CREATE OR REPLACE FUNCTION app.induction_policy_signing(p_profile_id uuid)
RETURNS TABLE (required integer, signed integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_worker uuid := app.staff_profile_worker(p_profile_id);
BEGIN
  IF v_worker IS NULL OR app.current_user_id() IS NULL OR NOT (
       v_worker = app.current_user_id()
       OR app.holds_staff_permission('workforce.staff_file.read')
       OR app.holds_staff_permission('workforce.staff_file.manage')) THEN
    RAISE EXCEPTION 'Read-and-sign counts need the staff file'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    WITH roles AS (
      SELECT r.key AS k FROM public.role_assignment ra
        JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
       WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = v_worker
         AND ra.deleted_at IS NULL AND r.deleted_at IS NULL
         AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
      UNION
      SELECT r.based_on_key FROM public.role_assignment ra
        JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
       WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = v_worker
         AND ra.deleted_at IS NULL AND r.deleted_at IS NULL AND r.based_on_key IS NOT NULL
         AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())),
    needed AS (
      SELECT v.id, v.policy_id, v.version_number, v.change FROM public.policy_version v
       WHERE v.tenant_id = app.current_tenant_id() AND v.state = 'published'
         AND v.deleted_at IS NULL AND v.roles && ARRAY(SELECT k FROM roles))
    SELECT count(*)::integer,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.policy_signature s
               JOIN public.policy_version sv ON sv.tenant_id = s.tenant_id
                                            AND sv.id = s.policy_version_id
              WHERE s.tenant_id = app.current_tenant_id() AND s.signer_id = v_worker
                AND sv.policy_id = n.policy_id
                AND (sv.id = n.id OR (n.change = 'minor' AND sv.state = 'superseded'
                     AND sv.version_number = (SELECT max(p.version_number)
                                                FROM public.policy_version p
                                               WHERE p.tenant_id = app.current_tenant_id()
                                                 AND p.policy_id = n.policy_id
                                                 AND p.state = 'superseded'
                                                 AND p.version_number < n.version_number)))))::integer
      FROM needed n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.induction_policy_signing(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.induction_policy_signing(uuid) TO harbour_app;
--> statement-breakpoint
-- Ending a leaver's access (rule 22): the member is marked as left (so they hold nothing and
-- their open invitations end, migration 0054), their roles end now and their grants are revoked.
-- By the sweep (the system) from the day after the leaving date, or at once by a holder of
-- workforce.staff_file.manage who is not the leaver; once only. Returns whether access ended.
CREATE OR REPLACE FUNCTION app.end_leaver_access(p_profile_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_worker uuid := app.staff_profile_worker(p_profile_id);
  v_leaver public.leaver_record%ROWTYPE;
BEGIN
  IF app.current_tenant_id() IS NULL OR v_worker IS NULL OR NOT (
       app.is_system() OR app.manages_staff_file_of(p_profile_id)) THEN
    RAISE EXCEPTION 'Ending a leaver''s access needs workforce.staff_file.manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_leaver FROM public.leaver_record l
   WHERE l.tenant_id = app.current_tenant_id() AND l.staff_profile_id = p_profile_id
     AND l.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record the leaving first'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_leaver.access_removed_at IS NOT NULL THEN
    RETURN false;
  END IF;
  UPDATE public.tenant_user SET status = 'left'
   WHERE tenant_id = app.current_tenant_id() AND id = v_worker AND status <> 'left';
  UPDATE public.role_assignment SET valid_to = now()
   WHERE tenant_id = app.current_tenant_id() AND tenant_user_id = v_worker
     AND deleted_at IS NULL AND (valid_to IS NULL OR valid_to > now());
  UPDATE public.access_grant SET revoked_at = now()
   WHERE tenant_id = app.current_tenant_id() AND tenant_user_id = v_worker
     AND revoked_at IS NULL;
  UPDATE public.leaver_record SET access_removed_at = now(), access_removed_by = v_me
   WHERE id = v_leaver.id;
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.end_leaver_access(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.end_leaver_access(uuid) TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.induction_plan, public.care_certificate_progress,
  public.leaver_record, public.reference_request TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.staff_checklist_item, public.shadow_shift, public.probation_review
  TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.induction_plan, public.care_certificate_progress,
  public.leaver_record, public.reference_request, public.staff_checklist_item,
  public.shadow_shift, public.probation_review FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE ON public.staff_checklist_item, public.shadow_shift, public.probation_review
  FROM harbour_app;
