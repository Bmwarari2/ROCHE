CREATE TABLE "applicant" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"given_name" text,
	"family_name" text,
	"email" text,
	"phone" text,
	"talent_pool_until" date,
	"talent_pool_consented_at" timestamp with time zone,
	"retain_until" date,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "applicant_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "applicant_talent_pool" CHECK ((talent_pool_until IS NULL) = (talent_pool_consented_at IS NULL)),
	CONSTRAINT "applicant_named" CHECK (redacted_at IS NOT NULL OR (length(btrim(given_name)) BETWEEN 1 AND 100
        AND length(btrim(family_name)) BETWEEN 1 AND 100)),
	CONSTRAINT "applicant_redacted" CHECK (redacted_at IS NULL OR (given_name IS NULL AND family_name IS NULL AND email IS NULL
        AND phone IS NULL AND talent_pool_until IS NULL))
);
--> statement-breakpoint
CREATE TABLE "application" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"applicant_id" uuid NOT NULL,
	"stage" text DEFAULT 'applied' NOT NULL,
	"stage_reason" text,
	"shortlist" jsonb,
	"closed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "application_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "application_once_key" UNIQUE("tenant_id","vacancy_id","applicant_id"),
	CONSTRAINT "application_stage" CHECK (stage IN ('applied', 'shortlisted', 'interviewed', 'offered', 'accepted', 'rejected', 'withdrawn', 'declined')),
	CONSTRAINT "application_reason" CHECK (stage_reason IS NULL OR stage_reason IN ('criteria_not_met', 'not_selected_after_interview', 'position_filled', 'vacancy_withdrawn', 'applicant_withdrew', 'offer_declined', 'offer_withdrawn', 'pre_employment_checks_failed')),
	CONSTRAINT "application_closed" CHECK ((closed_on IS NULL) = (stage NOT IN ('accepted', 'rejected', 'withdrawn', 'declined')))
);
--> statement-breakpoint
CREATE TABLE "application_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "application_event_stage" CHECK (to_stage IN ('applied', 'shortlisted', 'interviewed', 'offered', 'accepted', 'rejected', 'withdrawn', 'declined'))
);
--> statement-breakpoint
CREATE TABLE "equality_monitoring" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	CONSTRAINT "equality_monitoring_answers" CHECK (jsonb_typeof(answers) = 'object')
);
--> statement-breakpoint
CREATE TABLE "interview" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"application_id" uuid NOT NULL,
	"held_on" date NOT NULL,
	"panel" uuid[] NOT NULL,
	"scores" jsonb NOT NULL,
	"notes" text,
	"recommendation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "interview_panel" CHECK (cardinality(panel) BETWEEN 1 AND 5),
	CONSTRAINT "interview_scores" CHECK (jsonb_typeof(scores) = 'object'),
	CONSTRAINT "interview_recommendation" CHECK (recommendation IN ('proceed', 'do_not_proceed')),
	CONSTRAINT "interview_notes" CHECK (notes IS NULL OR length(notes) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "job_offer" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"application_id" uuid NOT NULL,
	"made_on" date NOT NULL,
	"proposed_start_on" date,
	"conditions" jsonb NOT NULL,
	"status" text DEFAULT 'made' NOT NULL,
	"responded_on" date,
	"staff_profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "job_offer_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_offer_once_key" UNIQUE("tenant_id","application_id"),
	CONSTRAINT "job_offer_status" CHECK (status IN ('made', 'accepted', 'declined', 'withdrawn')),
	CONSTRAINT "job_offer_conditions" CHECK (jsonb_typeof(conditions) = 'array'),
	CONSTRAINT "job_offer_responded" CHECK ((responded_on IS NULL) = (status = 'made')
        AND ((staff_profile_id IS NOT NULL) = (status = 'accepted')))
);
--> statement-breakpoint
CREATE TABLE "job_template" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"title" text NOT NULL,
	"pathway_category" text NOT NULL,
	"registration_body" text,
	"essential_criteria" jsonb NOT NULL,
	"values_questions" jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "job_template_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_template_title" CHECK (length(btrim(title)) BETWEEN 2 AND 120),
	CONSTRAINT "job_template_pathway" CHECK (pathway_category IN ('new_to_care', 'care_worker', 'senior_care_worker', 'lead_practitioner', 'deputy_manager', 'registered_manager', 'registered_nurse')),
	CONSTRAINT "job_template_registration_body" CHECK (registration_body IS NULL OR registration_body IN ('nmc', 'hcpc', 'swe', 'gmc')),
	CONSTRAINT "job_template_criteria" CHECK (jsonb_typeof(essential_criteria) = 'array' AND jsonb_array_length(essential_criteria) BETWEEN 2 AND 20),
	CONSTRAINT "job_template_questions" CHECK (jsonb_typeof(values_questions) = 'array' AND jsonb_array_length(values_questions) BETWEEN 2 AND 12)
);
--> statement-breakpoint
CREATE TABLE "vacancy" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"job_template_id" uuid NOT NULL,
	"location_id" uuid,
	"title" text NOT NULL,
	"positions" integer DEFAULT 1 NOT NULL,
	"opens_on" date NOT NULL,
	"closes_on" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"equality_summarised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vacancy_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "vacancy_title" CHECK (length(btrim(title)) BETWEEN 2 AND 120),
	CONSTRAINT "vacancy_positions" CHECK (positions BETWEEN 1 AND 50),
	CONSTRAINT "vacancy_dates" CHECK (closes_on IS NULL OR closes_on >= opens_on),
	CONSTRAINT "vacancy_status" CHECK (status IN ('draft', 'open', 'closed', 'filled', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_vacancy_fk" FOREIGN KEY ("tenant_id","vacancy_id") REFERENCES "public"."vacancy"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_applicant_fk" FOREIGN KEY ("tenant_id","applicant_id") REFERENCES "public"."applicant"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_application_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."application"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equality_monitoring" ADD CONSTRAINT "equality_monitoring_vacancy_fk" FOREIGN KEY ("tenant_id","vacancy_id") REFERENCES "public"."vacancy"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview" ADD CONSTRAINT "interview_application_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."application"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_offer" ADD CONSTRAINT "job_offer_application_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."application"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_offer" ADD CONSTRAINT "job_offer_staff_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy" ADD CONSTRAINT "vacancy_template_fk" FOREIGN KEY ("tenant_id","job_template_id") REFERENCES "public"."job_template"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy" ADD CONSTRAINT "vacancy_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applicant_email_idx" ON "applicant" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "application_event_application_idx" ON "application_event" USING btree ("tenant_id","application_id","occurred_at");--> statement-breakpoint
CREATE INDEX "equality_monitoring_vacancy_idx" ON "equality_monitoring" USING btree ("tenant_id","vacancy_id");
--> statement-breakpoint

-- Applicant tracking (slice 23; workforce.md sections 2b, 3 and rules 11 to 13; WORK-001): the
-- ADR-0002 patterns. Read and written only by holders of workforce.recruitment.manage, held
-- organisation-wide as the staff file permissions are (app.holds_staff_permission); stage events
-- and interviews are append-only; equality monitoring is insert only and read by nobody row by
-- row, only counted by app.equality_monitoring_counts (rule 12; DPIA risk R29). Runs as
-- harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_template', 'vacancy', 'applicant', 'application',
    'application_event', 'interview', 'job_offer', 'equality_monitoring'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['job_template', 'vacancy', 'applicant', 'application',
    'application_event', 'interview', 'job_offer'] LOOP
    EXECUTE format(
      'CREATE POLICY recruitment_only ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app '
      'USING (app.is_system() OR app.holds_staff_permission(''workforce.recruitment.manage'')) '
      'WITH CHECK (app.is_system() OR app.holds_staff_permission(''workforce.recruitment.manage''))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['job_template', 'vacancy', 'applicant', 'application', 'job_offer'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['application_event', 'interview', 'equality_monitoring'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Equality monitoring forms are added by a holder of the permission; nobody reads one.
-- Forms are added only once applications have closed and before the counts are first released
-- (rule 12): not one at a time as applications arrive, which would let the audit trail's timing
-- match a form to an application, and never after the counts were read, which would let counts
-- read before and after a form give its answers away.
CREATE POLICY equality_monitoring_add ON public.equality_monitoring AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.holds_staff_permission('workforce.recruitment.manage')
    AND EXISTS (SELECT 1 FROM public.vacancy v
                WHERE v.id = vacancy_id AND v.status <> 'open' AND v.status <> 'draft'
                  AND v.equality_summarised_at IS NULL));
--> statement-breakpoint
CREATE POLICY equality_monitoring_unread ON public.equality_monitoring AS RESTRICTIVE FOR SELECT
  TO harbour_app USING (false);
--> statement-breakpoint

-- A closed application never reopens (rule 11): a new application is made instead. Its applicant
-- and vacancy never change.
CREATE OR REPLACE FUNCTION app.application_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.vacancy_id, NEW.applicant_id) IS DISTINCT FROM (OLD.vacancy_id, OLD.applicant_id) THEN
    RAISE EXCEPTION 'An application keeps its applicant and vacancy'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.closed_on IS NOT NULL AND (NEW.stage, NEW.closed_on) IS DISTINCT FROM (OLD.stage, OLD.closed_on) THEN
    RAISE EXCEPTION 'A closed application does not reopen'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER application_guard BEFORE UPDATE ON public.application
  FOR EACH ROW EXECUTE FUNCTION app.application_guard();
--> statement-breakpoint

-- A redacted applicant stays redacted.
CREATE OR REPLACE FUNCTION app.applicant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    RAISE EXCEPTION 'A redacted applicant stays redacted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER applicant_guard BEFORE UPDATE ON public.applicant
  FOR EACH ROW EXECUTE FUNCTION app.applicant_guard();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.job_template, public.vacancy, public.applicant,
  public.application, public.job_offer TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.application_event, public.interview TO harbour_app;
--> statement-breakpoint
GRANT INSERT ON public.equality_monitoring TO harbour_app;
--> statement-breakpoint
-- Whatever the schema's default privileges gave: never a delete, never a change to an event, and
-- never a read of an equality monitoring form.
REVOKE DELETE, TRUNCATE ON public.job_template, public.vacancy, public.applicant,
  public.application, public.job_offer FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.application_event, public.interview FROM harbour_app;
--> statement-breakpoint
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON public.equality_monitoring FROM harbour_app;
--> statement-breakpoint

-- The counts of one vacancy's equality monitoring answers, per question and answer, with the
-- number of forms as question '__forms'. Only for a holder of workforce.recruitment.manage in the
-- session's organisation, and only once the vacancy is no longer open. A count from 1 to 4 comes
-- back as NULL ("fewer than 5", EQUALITY_MONITORING_MIN_COUNT in packages/domain, kept in step by
-- test/applicant-tracking.test.ts), so no caller ever sees a small number; the API suppresses
-- further (complementary cells, rule 12). Runs as its owner to read rows nobody else may; the
-- tenant policy still applies.
CREATE OR REPLACE FUNCTION app.equality_monitoring_counts(p_vacancy_id uuid)
RETURNS TABLE (question text, answer text, n bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.holds_staff_permission('workforce.recruitment.manage') THEN
    RAISE EXCEPTION 'Equality monitoring counts need workforce.recruitment.manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vacancy v
             WHERE v.tenant_id = app.current_tenant_id() AND v.id = p_vacancy_id
               AND v.status IN ('draft', 'open')) THEN
    RAISE EXCEPTION 'Equality monitoring counts are released once the vacancy has closed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN QUERY
    SELECT q.question, q.answer, CASE WHEN q.n = 0 OR q.n >= 5 THEN q.n END
      FROM (
        SELECT '__forms'::text AS question, ''::text AS answer, count(*) AS n
          FROM public.equality_monitoring m
         WHERE m.tenant_id = app.current_tenant_id() AND m.vacancy_id = p_vacancy_id
        UNION ALL
        SELECT a.key, a.value, count(*)
          FROM public.equality_monitoring m, jsonb_each_text(m.answers) a
         WHERE m.tenant_id = app.current_tenant_id() AND m.vacancy_id = p_vacancy_id
         GROUP BY a.key, a.value
      ) q;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.equality_monitoring_counts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.equality_monitoring_counts(uuid) TO harbour_app;
--> statement-breakpoint

-- Earlier versions of applicant records follow their own read rule.
CREATE POLICY record_version_recruitment ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('job_template', 'vacancy', 'applicant', 'application', 'job_offer')
    OR app.is_system()
    OR app.holds_staff_permission('workforce.recruitment.manage'));
