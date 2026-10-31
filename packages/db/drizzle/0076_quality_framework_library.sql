CREATE TABLE "evidence_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"statement_ids" text[] NOT NULL,
	"tagged_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"tagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"removal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "evidence_link_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "evidence_link_statements" CHECK (cardinality("evidence_link"."statement_ids") BETWEEN 1 AND 20),
	CONSTRAINT "evidence_link_record_type" CHECK ("evidence_link"."record_type" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "evidence_link_removal" CHECK (("evidence_link"."removed_at" IS NULL) = ("evidence_link"."removed_by" IS NULL)
        AND ("evidence_link"."removed_at" IS NULL) = ("evidence_link"."removal_reason" IS NULL)
        AND ("evidence_link"."removal_reason" IS NULL OR length(btrim("evidence_link"."removal_reason")) BETWEEN 3 AND 500))
);
--> statement-breakpoint
CREATE TABLE "framework_evidence_category" (
	"framework_version_id" uuid NOT NULL,
	"id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "framework_evidence_category_pkey" PRIMARY KEY("framework_version_id","id"),
	CONSTRAINT "framework_evidence_category_id" CHECK ("framework_evidence_category"."id" ~ '^[A-Za-z0-9._-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "framework_key_question" (
	"framework_version_id" uuid NOT NULL,
	"id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "framework_key_question_pkey" PRIMARY KEY("framework_version_id","id"),
	CONSTRAINT "framework_key_question_id" CHECK ("framework_key_question"."id" ~ '^[A-Za-z0-9._-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "framework_mapping" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"mapping_version" integer NOT NULL,
	"entries" jsonb NOT NULL,
	"made_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"made_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "framework_mapping_version_key" UNIQUE("tenant_id","framework_version_id","mapping_version"),
	CONSTRAINT "framework_mapping_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "framework_mapping_version_positive" CHECK ("framework_mapping"."mapping_version" >= 1),
	CONSTRAINT "framework_mapping_entries_array" CHECK (jsonb_typeof("framework_mapping"."entries") = 'array')
);
--> statement-breakpoint
CREATE TABLE "framework_statement" (
	"framework_version_id" uuid NOT NULL,
	"id" text NOT NULL,
	"key_question_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "framework_statement_pkey" PRIMARY KEY("framework_version_id","id"),
	CONSTRAINT "framework_statement_id" CHECK ("framework_statement"."id" ~ '^[A-Za-z0-9._-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "framework_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"framework_key" text NOT NULL,
	"regulator" text NOT NULL,
	"version_number" integer NOT NULL,
	"state" text NOT NULL,
	"published_on" date,
	"retired_on" date,
	"source_name" text NOT NULL,
	"source_provision" text NOT NULL,
	"source_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "framework_version_number_key" UNIQUE("framework_key","version_number"),
	CONSTRAINT "framework_version_regulator" CHECK ("framework_version"."regulator" IN ('cqc', 'ciw', 'care_inspectorate', 'rqia')),
	CONSTRAINT "framework_version_state" CHECK ("framework_version"."state" IN ('draft', 'published', 'retired')),
	CONSTRAINT "framework_version_source_https" CHECK ("framework_version"."source_url" LIKE 'https://%'),
	CONSTRAINT "framework_version_dates" CHECK (("framework_version"."state" = 'draft') = ("framework_version"."published_on" IS NULL)
        AND ("framework_version"."retired_on" IS NULL OR "framework_version"."retired_on" > "framework_version"."published_on")
        AND (("framework_version"."state" = 'retired') = ("framework_version"."retired_on" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_framework_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_evidence_category" ADD CONSTRAINT "framework_evidence_category_framework_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_key_question" ADD CONSTRAINT "framework_key_question_framework_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_mapping" ADD CONSTRAINT "framework_mapping_framework_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_statement" ADD CONSTRAINT "framework_statement_key_question_fk" FOREIGN KEY ("framework_version_id","key_question_id") REFERENCES "public"."framework_key_question"("framework_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_link_record_idx" ON "evidence_link" USING btree ("tenant_id","record_type","record_id");--> statement-breakpoint
CREATE INDEX "evidence_link_statements_idx" ON "evidence_link" USING gin ("statement_ids");--> statement-breakpoint

-- Security, guards and seed (quality.md section 18; QUAL-001, QUAL-002; ADR-0096; HZ-011). Runs as
-- harbour_owner. The framework tables are global reference data with no tenant: readable by every
-- role, written only here and by later migrations (a new framework is a new version, never an
-- edit). The tenant tables have forced RLS with the tenant policy; framework_mapping is append-only
-- (one row per mapping version) and evidence_link changes only to be removed.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['framework_version', 'framework_key_question', 'framework_statement',
      'framework_evidence_category'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY global_read ON public.%I AS PERMISSIVE FOR SELECT TO PUBLIC USING (true)', t);
    EXECUTE format('CREATE POLICY owner_maintenance ON public.%I AS PERMISSIVE FOR ALL TO harbour_owner '
      'USING (true) WITH CHECK (true)', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM harbour_app, harbour_worker', t);
    EXECUTE format('GRANT SELECT ON public.%I TO harbour_app, harbour_worker', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['framework_mapping', 'evidence_link'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    -- The evidence library is the quality lead's: holders of quality.evidence.manage (or a job).
    EXECUTE format(
      'CREATE POLICY evidence_library_permission ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app '
      'USING (app.is_system() OR app.holds_permission_anywhere(''quality.evidence.manage'')) '
      'WITH CHECK (app.is_system() OR app.holds_permission_anywhere(''quality.evidence.manage''))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A published framework version's content never changes: a change is a new version (rule 2).
CREATE OR REPLACE FUNCTION app.framework_content_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  SELECT state INTO v_state FROM public.framework_version
   WHERE id = (CASE WHEN TG_OP = 'INSERT' THEN NEW.framework_version_id ELSE OLD.framework_version_id END);
  IF v_state IS DISTINCT FROM 'draft' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A published framework version never changes; add a new version'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['framework_key_question', 'framework_statement',
      'framework_evidence_category'] LOOP
    EXECUTE format('CREATE TRIGGER framework_content_guard BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.framework_content_guard()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- A framework version moves draft to published to retired, and only its state and dates change.
CREATE OR REPLACE FUNCTION app.framework_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A framework version is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.framework_key, NEW.regulator, NEW.version_number, NEW.source_url)
       IS DISTINCT FROM (OLD.framework_key, OLD.regulator, OLD.version_number, OLD.source_url)
     OR NOT ((OLD.state = NEW.state AND OLD.state = 'draft')
          OR (OLD.state = 'draft' AND NEW.state = 'published')
          OR (OLD.state = 'published' AND NEW.state = 'retired'
              AND NEW.published_on = OLD.published_on)) THEN
    RAISE EXCEPTION 'A framework version only moves draft to published to retired'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER framework_version_guard BEFORE UPDATE OR DELETE ON public.framework_version
  FOR EACH ROW EXECUTE FUNCTION app.framework_version_guard();
--> statement-breakpoint

-- A mapping version is the next for its tenant and framework version, of a published framework,
-- in the maker's name, and names only that version's statements and evidence categories (rule 5).
CREATE OR REPLACE FUNCTION app.framework_mapping_add() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_bad int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.framework_version v
                 WHERE v.id = NEW.framework_version_id AND v.state = 'published') THEN
    RAISE EXCEPTION 'Map only a published framework version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.mapping_version IS DISTINCT FROM coalesce((SELECT max(m.mapping_version) FROM public.framework_mapping m
       WHERE m.tenant_id = NEW.tenant_id AND m.framework_version_id = NEW.framework_version_id), 0) + 1 THEN
    RAISE EXCEPTION 'The mapping changed since it was read' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF app.current_user_id() IS NOT NULL AND NEW.made_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A mapping is made in its maker''s name' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(NEW.entries) e
   WHERE jsonb_typeof(e) <> 'object'
      OR NOT EXISTS (SELECT 1 FROM public.framework_statement s
                     WHERE s.framework_version_id = NEW.framework_version_id AND s.id = e->>'statementId')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(e->'evidenceCategoryIds', '[]'::jsonb)) c
                 WHERE NOT EXISTS (SELECT 1 FROM public.framework_evidence_category k
                   WHERE k.framework_version_id = NEW.framework_version_id AND k.id = c));
  IF v_bad > 0 OR (SELECT count(DISTINCT e->>'statementId') FROM jsonb_array_elements(NEW.entries) e)
       <> jsonb_array_length(NEW.entries) THEN
    RAISE EXCEPTION 'A mapping names each statement of its framework version once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.made_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER framework_mapping_add BEFORE INSERT ON public.framework_mapping
  FOR EACH ROW EXECUTE FUNCTION app.framework_mapping_add();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.framework_mapping
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.framework_mapping
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- An evidence link names statements of a published framework version, in the tagger's name
-- (rule 6); afterwards it only changes to be removed, once, with who and why.
CREATE OR REPLACE FUNCTION app.evidence_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.framework_version v
                   WHERE v.id = NEW.framework_version_id AND v.state = 'published')
       OR EXISTS (SELECT 1 FROM unnest(NEW.statement_ids) s(id)
                  WHERE NOT EXISTS (SELECT 1 FROM public.framework_statement f
                    WHERE f.framework_version_id = NEW.framework_version_id AND f.id = s.id)) THEN
      RAISE EXCEPTION 'Tag evidence against statements of a published framework version'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF num_nonnulls(NEW.removed_at, NEW.removed_by, NEW.removal_reason, NEW.deleted_at) > 0
       OR (app.current_user_id() IS NOT NULL AND NEW.tagged_by IS DISTINCT FROM app.current_user_id()) THEN
      RAISE EXCEPTION 'An evidence link starts in its tagger''s name' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.tagged_at := now();
    RETURN NEW;
  END IF;
  IF OLD.removed_at IS NOT NULL
     OR NEW.removed_at IS NULL
     OR (NEW.tenant_id, NEW.record_type, NEW.record_id, NEW.framework_version_id, NEW.statement_ids,
         NEW.tagged_by, NEW.tagged_at, NEW.deleted_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.record_type, OLD.record_id, OLD.framework_version_id,
         OLD.statement_ids, OLD.tagged_by, OLD.tagged_at, OLD.deleted_at)
     OR (app.current_user_id() IS NOT NULL AND NEW.removed_by IS DISTINCT FROM app.current_user_id()) THEN
    RAISE EXCEPTION 'An evidence link only changes to be removed, once, in the remover''s name'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.removed_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_link_guard BEFORE INSERT OR UPDATE ON public.evidence_link
  FOR EACH ROW EXECUTE FUNCTION app.evidence_link_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.evidence_link
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.evidence_link
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.evidence_link
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.framework_mapping TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.framework_mapping FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.evidence_link TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.evidence_link FROM harbour_app;
--> statement-breakpoint

-- Version 1: CQC's single assessment framework as published (ADR-0096): 5 key questions, 34 quality
-- statements and 6 evidence categories, with the source; titles to be checked against the CQC page
-- (H-606). The key question ids are the ones the evidence pack screens already send.
INSERT INTO public.framework_version (id, framework_key, regulator, version_number, state,
    published_on, retired_on, source_name, source_provision, source_url)
  VALUES ('0192f1a0-0000-7000-8000-000000000001', 'cqc_single_assessment', 'cqc', 1, 'published', '2023-11-20', NULL,
    'Care Quality Commission', 'Single assessment framework: key questions, quality statements and evidence categories',
    'https://www.cqc.org.uk/assessment/quality-statements');
--> statement-breakpoint
INSERT INTO public.framework_key_question (framework_version_id, id, position, title) VALUES
    ('0192f1a0-0000-7000-8000-000000000001', 'safe', 1, 'Safe'),
    ('0192f1a0-0000-7000-8000-000000000001', 'effective', 2, 'Effective'),
    ('0192f1a0-0000-7000-8000-000000000001', 'caring', 3, 'Caring'),
    ('0192f1a0-0000-7000-8000-000000000001', 'responsive', 4, 'Responsive'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led', 5, 'Well-led');
--> statement-breakpoint
INSERT INTO public.framework_statement (framework_version_id, id, key_question_id, position, title) VALUES
    ('0192f1a0-0000-7000-8000-000000000001', 'safe.learning_culture', 'safe', 1, 'Learning culture'),
    ('0192f1a0-0000-7000-8000-000000000001', 'safe.safe_systems_pathways_and_transitions', 'safe', 2, 'Safe systems, pathways and transitions'),
    ('0192f1a0-0000-7000-8000-000000000001', 'safe.safeguarding', 'safe', 3, 'Safeguarding'),
    ('0192f1a0-0000-7000-8000-000000000001', 'safe.involving_people_to_manage_risks', 'safe', 4, 'Involving people to manage risks'),
    ('0192f1a0-0000-7000-8000-000000000001', 'safe.safe_environments', 'safe', 5, 'Safe environments'),
    ('0192f1a0-0000-7000-8000-000000000001', 'safe.safe_and_effective_staffing', 'safe', 6, 'Safe and effective staffing'),
    ('0192f1a0-0000-7000-8000-000000000001', 'safe.infection_prevention_and_control', 'safe', 7, 'Infection prevention and control'),
    ('0192f1a0-0000-7000-8000-000000000001', 'safe.medicines_optimisation', 'safe', 8, 'Medicines optimisation'),
    ('0192f1a0-0000-7000-8000-000000000001', 'effective.assessing_needs', 'effective', 9, 'Assessing needs'),
    ('0192f1a0-0000-7000-8000-000000000001', 'effective.delivering_evidence_based_care_and_treatment', 'effective', 10, 'Delivering evidence-based care and treatment'),
    ('0192f1a0-0000-7000-8000-000000000001', 'effective.how_staff_teams_and_services_work_together', 'effective', 11, 'How staff, teams and services work together'),
    ('0192f1a0-0000-7000-8000-000000000001', 'effective.supporting_people_to_live_healthier_lives', 'effective', 12, 'Supporting people to live healthier lives'),
    ('0192f1a0-0000-7000-8000-000000000001', 'effective.monitoring_and_improving_outcomes', 'effective', 13, 'Monitoring and improving outcomes'),
    ('0192f1a0-0000-7000-8000-000000000001', 'effective.consent_to_care_and_treatment', 'effective', 14, 'Consent to care and treatment'),
    ('0192f1a0-0000-7000-8000-000000000001', 'caring.kindness_compassion_and_dignity', 'caring', 15, 'Kindness, compassion and dignity'),
    ('0192f1a0-0000-7000-8000-000000000001', 'caring.treating_people_as_individuals', 'caring', 16, 'Treating people as individuals'),
    ('0192f1a0-0000-7000-8000-000000000001', 'caring.independence_choice_and_control', 'caring', 17, 'Independence, choice and control'),
    ('0192f1a0-0000-7000-8000-000000000001', 'caring.responding_to_peoples_immediate_needs', 'caring', 18, 'Responding to people''s immediate needs'),
    ('0192f1a0-0000-7000-8000-000000000001', 'caring.workforce_wellbeing_and_enablement', 'caring', 19, 'Workforce wellbeing and enablement'),
    ('0192f1a0-0000-7000-8000-000000000001', 'responsive.person_centred_care', 'responsive', 20, 'Person-centred care'),
    ('0192f1a0-0000-7000-8000-000000000001', 'responsive.care_provision_integration_and_continuity', 'responsive', 21, 'Care provision, integration and continuity'),
    ('0192f1a0-0000-7000-8000-000000000001', 'responsive.providing_information', 'responsive', 22, 'Providing information'),
    ('0192f1a0-0000-7000-8000-000000000001', 'responsive.listening_to_and_involving_people', 'responsive', 23, 'Listening to and involving people'),
    ('0192f1a0-0000-7000-8000-000000000001', 'responsive.equity_in_access', 'responsive', 24, 'Equity in access'),
    ('0192f1a0-0000-7000-8000-000000000001', 'responsive.equity_in_experiences_and_outcomes', 'responsive', 25, 'Equity in experiences and outcomes'),
    ('0192f1a0-0000-7000-8000-000000000001', 'responsive.planning_for_the_future', 'responsive', 26, 'Planning for the future'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led.shared_direction_and_culture', 'well-led', 27, 'Shared direction and culture'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led.capable_compassionate_and_inclusive_leaders', 'well-led', 28, 'Capable, compassionate and inclusive leaders'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led.freedom_to_speak_up', 'well-led', 29, 'Freedom to speak up'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led.workforce_equality_diversity_and_inclusion', 'well-led', 30, 'Workforce equality, diversity and inclusion'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led.governance_management_and_sustainability', 'well-led', 31, 'Governance, management and sustainability'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led.partnerships_and_communities', 'well-led', 32, 'Partnerships and communities'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led.learning_improvement_and_innovation', 'well-led', 33, 'Learning, improvement and innovation'),
    ('0192f1a0-0000-7000-8000-000000000001', 'well-led.environmental_sustainability_sustainable_developme', 'well-led', 34, 'Environmental sustainability: sustainable development');
--> statement-breakpoint
INSERT INTO public.framework_evidence_category (framework_version_id, id, position, title) VALUES
    ('0192f1a0-0000-7000-8000-000000000001', 'peoples_experience', 1, 'People''s experience of health and care services'),
    ('0192f1a0-0000-7000-8000-000000000001', 'staff_and_leaders', 2, 'Feedback from staff and leaders'),
    ('0192f1a0-0000-7000-8000-000000000001', 'partners', 3, 'Feedback from partners'),
    ('0192f1a0-0000-7000-8000-000000000001', 'observation', 4, 'Observation'),
    ('0192f1a0-0000-7000-8000-000000000001', 'processes', 5, 'Processes'),
    ('0192f1a0-0000-7000-8000-000000000001', 'outcomes', 6, 'Outcomes');