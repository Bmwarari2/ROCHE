CREATE TABLE "audit_action" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"audit_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"description" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "audit_action_description" CHECK (length(btrim("audit_action"."description")) BETWEEN 3 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "audit_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"questions" jsonb NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"audited_on" date NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"score_percent" numeric(6, 3),
	"achieved" numeric(10, 2),
	"possible" integer,
	"self_rating" integer,
	"started_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "audit_record_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "audit_record_kind" CHECK ("audit_record"."kind" IN ('medication', 'care_plans', 'ipc', 'environment', 'dignity', 'night_visit', 'mock_inspection', 'other')),
	CONSTRAINT "audit_record_state" CHECK ("audit_record"."state" IN ('in_progress', 'completed')),
	CONSTRAINT "audit_record_answers" CHECK (jsonb_typeof("audit_record"."answers") = 'object'),
	CONSTRAINT "audit_record_completion" CHECK (("audit_record"."state" = 'completed') = ("audit_record"."completed_at" IS NOT NULL)
        AND ("audit_record"."completed_at" IS NULL) = ("audit_record"."completed_by" IS NULL)
        AND ("audit_record"."state" = 'in_progress' OR "audit_record"."self_rating" IS NOT NULL)
        AND ("audit_record"."self_rating" IS NULL OR "audit_record"."self_rating" >= 1)
        AND ("audit_record"."score_percent" IS NULL OR "audit_record"."score_percent" BETWEEN 0 AND 100))
);
--> statement-breakpoint
CREATE TABLE "audit_schedule" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"template_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"frequency_months" integer NOT NULL,
	"first_due_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "audit_schedule_template_location" UNIQUE("tenant_id","template_id","location_id"),
	CONSTRAINT "audit_schedule_frequency" CHECK ("audit_schedule"."frequency_months" BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "audit_starter_template" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"questions" jsonb NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "audit_starter_template_kind" CHECK ("audit_starter_template"."kind" IN ('medication', 'care_plans', 'ipc', 'environment', 'dignity', 'night_visit', 'mock_inspection', 'other')),
	CONSTRAINT "audit_starter_template_questions" CHECK (jsonb_typeof("audit_starter_template"."questions") = 'array')
);
--> statement-breakpoint
CREATE TABLE "audit_template" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"questions" jsonb NOT NULL,
	"starter_key" text,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "audit_template_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "audit_template_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "audit_template_kind" CHECK ("audit_template"."kind" IN ('medication', 'care_plans', 'ipc', 'environment', 'dignity', 'night_visit', 'mock_inspection', 'other')),
	CONSTRAINT "audit_template_state" CHECK ("audit_template"."state" IN ('active', 'retired')),
	CONSTRAINT "audit_template_key_format" CHECK ("audit_template"."key" ~ '^[a-z0-9_-]{1,64}$'),
	CONSTRAINT "audit_template_questions" CHECK (jsonb_typeof("audit_template"."questions") = 'array' AND jsonb_array_length("audit_template"."questions") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "audit_action" ADD CONSTRAINT "audit_action_audit_fk" FOREIGN KEY ("tenant_id","audit_id") REFERENCES "public"."audit_record"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."audit_template"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_framework_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule" ADD CONSTRAINT "audit_schedule_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."audit_template"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_starter_template" ADD CONSTRAINT "audit_starter_template_framework_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_template" ADD CONSTRAINT "audit_template_framework_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_action" ADD CONSTRAINT "audit_action_owner_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule" ADD CONSTRAINT "audit_schedule_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_action_audit_idx" ON "audit_action" USING btree ("tenant_id","audit_id");--> statement-breakpoint
CREATE INDEX "audit_record_location_idx" ON "audit_record" USING btree ("tenant_id","location_id","audited_on");--> statement-breakpoint

-- Security, guards and seed (quality.md section 19; QUAL-004; HZ-011). Runs as harbour_owner.
-- Starter templates are global reference data: read by every role, written only in migrations.
-- An organisation's templates are its quality leads'; schedules, audits and actions are seen and
-- changed only where the member holds quality.audit.manage at the audit's location. An audit keeps
-- the questions and framework version it started with, and is fixed once completed.
ALTER TABLE public.audit_starter_template ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.audit_starter_template FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY global_read ON public.audit_starter_template AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
--> statement-breakpoint
CREATE POLICY owner_maintenance ON public.audit_starter_template AS PERMISSIVE FOR ALL TO harbour_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_starter_template FROM harbour_app, harbour_worker;
--> statement-breakpoint
GRANT SELECT ON public.audit_starter_template TO harbour_app, harbour_worker;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_template', 'audit_schedule', 'audit_record', 'audit_action'] LOOP
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
CREATE POLICY audit_template_permission ON public.audit_template AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.is_system() OR app.holds_permission_anywhere('quality.audit.manage'))
  WITH CHECK (app.is_system() OR app.holds_permission_anywhere('quality.audit.manage'));
--> statement-breakpoint
CREATE POLICY audit_schedule_location ON public.audit_schedule AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.is_system() OR app.holds_permission_at('quality.audit.manage', location_id))
  WITH CHECK (app.is_system() OR app.holds_permission_at('quality.audit.manage', location_id));
--> statement-breakpoint
CREATE POLICY audit_record_location ON public.audit_record AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.is_system() OR app.holds_permission_at('quality.audit.manage', location_id))
  WITH CHECK (app.is_system() OR app.holds_permission_at('quality.audit.manage', location_id));
--> statement-breakpoint
CREATE POLICY audit_action_location ON public.audit_action AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.is_system() OR EXISTS (SELECT 1 FROM public.audit_record r
    WHERE r.id = audit_id AND app.holds_permission_at('quality.audit.manage', r.location_id)))
  WITH CHECK (app.is_system() OR EXISTS (SELECT 1 FROM public.audit_record r
    WHERE r.id = audit_id AND app.holds_permission_at('quality.audit.manage', r.location_id)));
--> statement-breakpoint

-- A template maps to a published framework version; a retired template never changes again.
CREATE OR REPLACE FUNCTION app.audit_template_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = 'retired' THEN
    RAISE EXCEPTION 'A retired audit template never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.framework_version_id IS DISTINCT FROM OLD.framework_version_id)
     AND NOT EXISTS (SELECT 1 FROM public.framework_version v
                     WHERE v.id = NEW.framework_version_id AND v.state = 'published') THEN
    RAISE EXCEPTION 'An audit template maps to the framework in use' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'An audit template keeps its key' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_template_guard BEFORE INSERT OR UPDATE ON public.audit_template
  FOR EACH ROW EXECUTE FUNCTION app.audit_template_guard();
--> statement-breakpoint

-- An audit starts in progress from its template as it stands (questions, version, framework,
-- kind and title copied by the database), in the starter's name. Those never change afterwards,
-- and a completed audit never changes at all; completion records who and when.
CREATE OR REPLACE FUNCTION app.audit_record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t public.audit_template;
  pts_achieved numeric;
  pts_possible numeric;
  unanswered integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO t FROM public.audit_template WHERE id = NEW.template_id;
    IF t.id IS NULL OR t.state <> 'active' THEN
      RAISE EXCEPTION 'Start an audit from an active template' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.state IS DISTINCT FROM 'in_progress'
       OR num_nonnulls(NEW.completed_at, NEW.completed_by, NEW.self_rating, NEW.score_percent,
                      NEW.achieved, NEW.possible, NEW.deleted_at) > 0
       OR (app.current_user_id() IS NOT NULL AND NEW.started_by IS DISTINCT FROM app.current_user_id()) THEN
      RAISE EXCEPTION 'An audit starts in progress in its auditor''s name' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.template_version := t.version;
    NEW.questions := t.questions;
    NEW.framework_version_id := t.framework_version_id;
    NEW.kind := t.kind;
    NEW.title := t.title;
    RETURN NEW;
  END IF;
  IF OLD.state = 'completed' THEN
    RAISE EXCEPTION 'A completed audit never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.tenant_id, NEW.template_id, NEW.template_version, NEW.questions, NEW.framework_version_id,
      NEW.location_id, NEW.kind, NEW.title, NEW.started_by, NEW.audited_on, NEW.deleted_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.template_id, OLD.template_version, OLD.questions,
      OLD.framework_version_id, OLD.location_id, OLD.kind, OLD.title, OLD.started_by, OLD.audited_on,
      OLD.deleted_at) THEN
    RAISE EXCEPTION 'An audit keeps the template, framework and place it started with'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'completed' THEN
    -- Completion stores the score of the answers as they stand: every question answered, the
    -- answers unchanged in the same statement, the points worked out here and the percentage
    -- matching them (yes in full, partial half, no nothing, not applicable left out).
    IF NEW.answers IS DISTINCT FROM OLD.answers THEN
      RAISE EXCEPTION 'Save the answers before completing the audit' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT count(*) FILTER (WHERE a.v IS NULL OR a.v NOT IN ('yes', 'partial', 'no', 'not_applicable')),
           coalesce(sum((q->>'weight')::numeric) FILTER (WHERE a.v IN ('yes', 'partial', 'no')), 0),
           coalesce(sum((q->>'weight')::numeric * CASE a.v WHEN 'yes' THEN 1 WHEN 'partial' THEN 0.5 ELSE 0 END)
                    FILTER (WHERE a.v IN ('yes', 'partial', 'no')), 0)
      INTO unanswered, pts_possible, pts_achieved
      FROM jsonb_array_elements(NEW.questions) AS q
      CROSS JOIN LATERAL (SELECT NEW.answers->>(q->>'key') AS v) AS a;
    IF unanswered > 0 OR NEW.self_rating IS NULL
       OR NEW.possible IS DISTINCT FROM pts_possible OR NEW.achieved IS DISTINCT FROM pts_achieved
       OR (pts_possible = 0 AND NEW.score_percent IS NOT NULL)
       OR (pts_possible > 0 AND (NEW.score_percent IS NULL
           OR abs(NEW.score_percent - pts_achieved * 100 / pts_possible) > 0.001)) THEN
      RAISE EXCEPTION 'A completed audit stores the score of its answers and a self-rating'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.completed_at := now();
    NEW.completed_by := coalesce(app.current_user_id(), NEW.completed_by);
  ELSIF num_nonnulls(NEW.completed_at, NEW.completed_by, NEW.self_rating, NEW.score_percent,
                     NEW.achieved, NEW.possible) > 0 THEN
    RAISE EXCEPTION 'Only completion records the self-rating' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_record_guard BEFORE INSERT OR UPDATE ON public.audit_record
  FOR EACH ROW EXECUTE FUNCTION app.audit_record_guard();
--> statement-breakpoint

-- Actions belong to a completed audit and are written by the person who completed it (or a job).
CREATE OR REPLACE FUNCTION app.audit_action_add() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.audit_record r
                 WHERE r.id = NEW.audit_id AND r.state = 'completed'
                   AND (app.current_user_id() IS NULL OR r.completed_by = app.current_user_id())
                   AND NEW.due_on >= r.audited_on
                   AND r.questions @> jsonb_build_array(jsonb_build_object('key', NEW.question_key))) THEN
    RAISE EXCEPTION 'An action belongs to a question of a completed audit, due on or after it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_action_add BEFORE INSERT ON public.audit_action
  FOR EACH ROW EXECUTE FUNCTION app.audit_action_add();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.audit_action
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.audit_action
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_template', 'audit_schedule', 'audit_record'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON public.audit_template, public.audit_schedule, public.audit_record TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.audit_template, public.audit_schedule, public.audit_record FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.audit_action TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_action FROM harbour_app;
--> statement-breakpoint

-- Starter templates (ADR-0096 version 1 statements): medication, care plans, IPC (the template
-- slice 31 builds on), environment, dignity, night visit and mock inspection. Harbour's starting
-- points for each organisation to review and adapt (H-760).
INSERT INTO public.audit_starter_template (key, kind, title, framework_version_id, questions, source) VALUES
    ('medication', 'medication', 'Medication audit', '0192f1a0-0000-7000-8000-000000000001', '[{"key": "mar_complete", "text": "Every MAR entry for the last 7 days is signed, or has a reason code", "weight": 2, "statementIds": ["safe.medicines_optimisation"], "actionRequired": true}, {"key": "storage", "text": "Medicines are stored securely at the right temperature, with daily temperature records", "weight": 1, "statementIds": ["safe.medicines_optimisation", "safe.safe_environments"], "actionRequired": true}, {"key": "cd_register", "text": "The controlled drugs register balances with the stock counted today", "weight": 2, "statementIds": ["safe.medicines_optimisation"], "actionRequired": true}, {"key": "prn", "text": "Each PRN medicine has a protocol, and its effect is recorded after each dose", "weight": 1, "statementIds": ["safe.medicines_optimisation", "effective.delivering_evidence_based_care_and_treatment"], "actionRequired": true}, {"key": "competence", "text": "Everyone who gave medicines this month has an in-date competence assessment", "weight": 1, "statementIds": ["safe.safe_and_effective_staffing"], "actionRequired": true}]'::jsonb, 'Harbour starter template, to be reviewed by the tenant (H-760)'),
    ('care_plans', 'care_plans', 'Care plan audit', '0192f1a0-0000-7000-8000-000000000001', '[{"key": "reviewed", "text": "Each care plan sampled was reviewed by its review date", "weight": 2, "statementIds": ["effective.assessing_needs"], "actionRequired": true}, {"key": "involved", "text": "The person, or someone who knows them well, took part and it shows in their words", "weight": 2, "statementIds": ["responsive.person_centred_care", "caring.independence_choice_and_control"], "actionRequired": true}, {"key": "risks", "text": "Each risk identified has a risk assessment linked to the plan", "weight": 1, "statementIds": ["safe.involving_people_to_manage_risks"], "actionRequired": true}, {"key": "consent", "text": "Consent or a capacity assessment and best interests decision is recorded where needed", "weight": 2, "statementIds": ["effective.consent_to_care_and_treatment"], "actionRequired": true}, {"key": "communication", "text": "Communication needs are recorded and met (Accessible Information Standard)", "weight": 1, "statementIds": ["responsive.providing_information"], "actionRequired": true}]'::jsonb, 'Harbour starter template, to be reviewed by the tenant (H-760)'),
    ('ipc', 'ipc', 'Infection prevention and control audit', '0192f1a0-0000-7000-8000-000000000001', '[{"key": "hand_hygiene", "text": "Staff observed washing or sanitising their hands at the right moments", "weight": 2, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true}, {"key": "ppe", "text": "Personal protective equipment is available where care is given, and used correctly", "weight": 1, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true}, {"key": "cleaning", "text": "Cleaning schedules are complete for the last 7 days", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "safe.safe_environments"], "actionRequired": true}, {"key": "laundry", "text": "Soiled laundry is kept apart from clean, in the right bags", "weight": 1, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true}, {"key": "sharps", "text": "Sharps bins are in date, not overfilled and stored safely", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "safe.safe_environments"], "actionRequired": true}]'::jsonb, 'Harbour starter template, to be reviewed by the tenant (H-760)'),
    ('environment', 'environment', 'Environment audit', '0192f1a0-0000-7000-8000-000000000001', '[{"key": "fire", "text": "Fire alarm and emergency lighting checks are recorded and in date", "weight": 2, "statementIds": ["safe.safe_environments"], "actionRequired": true}, {"key": "water", "text": "Hot water outlets are checked and within safe temperatures", "weight": 1, "statementIds": ["safe.safe_environments"], "actionRequired": true}, {"key": "equipment", "text": "Hoists, slings and beds have in-date servicing", "weight": 2, "statementIds": ["safe.safe_environments"], "actionRequired": true}, {"key": "call_bells", "text": "Call bells are within reach and working in every room checked", "weight": 1, "statementIds": ["safe.safe_environments", "caring.responding_to_peoples_immediate_needs"], "actionRequired": true}, {"key": "hazards", "text": "Corridors and rooms are free of trip hazards and clutter", "weight": 1, "statementIds": ["safe.safe_environments"], "actionRequired": true}]'::jsonb, 'Harbour starter template, to be reviewed by the tenant (H-760)'),
    ('dignity', 'dignity', 'Dignity audit', '0192f1a0-0000-7000-8000-000000000001', '[{"key": "privacy", "text": "Doors are closed and people covered during personal care", "weight": 2, "statementIds": ["caring.kindness_compassion_and_dignity"], "actionRequired": true}, {"key": "choice", "text": "People choose their clothes, food and how they spend the day", "weight": 1, "statementIds": ["caring.independence_choice_and_control"], "actionRequired": true}, {"key": "names", "text": "Staff use the name each person prefers", "weight": 1, "statementIds": ["caring.treating_people_as_individuals"], "actionRequired": true}, {"key": "mealtimes", "text": "People who need help to eat get it promptly and at their pace", "weight": 1, "statementIds": ["caring.kindness_compassion_and_dignity", "effective.supporting_people_to_live_healthier_lives"], "actionRequired": true}]'::jsonb, 'Harbour starter template, to be reviewed by the tenant (H-760)'),
    ('night_visit', 'night_visit', 'Night visit', '0192f1a0-0000-7000-8000-000000000001', '[{"key": "staffing", "text": "Staff on duty match the rota and the numbers planned", "weight": 2, "statementIds": ["safe.safe_and_effective_staffing"], "actionRequired": true}, {"key": "checks", "text": "Night checks are recorded at the times in each care plan", "weight": 1, "statementIds": ["safe.involving_people_to_manage_risks"], "actionRequired": true}, {"key": "call_bells", "text": "Call bells are answered promptly", "weight": 2, "statementIds": ["caring.responding_to_peoples_immediate_needs"], "actionRequired": true}, {"key": "security", "text": "External doors are secure and the building is safe", "weight": 1, "statementIds": ["safe.safe_environments"], "actionRequired": true}, {"key": "handover", "text": "The night handover covered everyone with a change or concern", "weight": 1, "statementIds": ["safe.safe_systems_pathways_and_transitions"], "actionRequired": true}]'::jsonb, 'Harbour starter template, to be reviewed by the tenant (H-760)'),
    ('mock_inspection', 'mock_inspection', 'Mock inspection', '0192f1a0-0000-7000-8000-000000000001', '[{"key": "learning", "text": "Staff can describe a recent incident and what changed because of it", "weight": 2, "statementIds": ["safe.learning_culture"], "actionRequired": true}, {"key": "safeguarding", "text": "Staff know how to raise a safeguarding concern and to whom", "weight": 2, "statementIds": ["safe.safeguarding"], "actionRequired": true}, {"key": "outcomes", "text": "The service monitors outcomes for people and acts on them", "weight": 1, "statementIds": ["effective.monitoring_and_improving_outcomes"], "actionRequired": true}, {"key": "kindness", "text": "Interactions observed were kind, respectful and unhurried", "weight": 2, "statementIds": ["caring.kindness_compassion_and_dignity"], "actionRequired": true}, {"key": "feedback", "text": "People and families are asked for their views and it shows what changed", "weight": 1, "statementIds": ["responsive.listening_to_and_involving_people"], "actionRequired": true}, {"key": "speak_up", "text": "Staff know how to speak up and feel they would be heard", "weight": 1, "statementIds": ["well-led.freedom_to_speak_up"], "actionRequired": true}, {"key": "governance", "text": "Audits, actions and risks are reviewed by leaders and followed up", "weight": 2, "statementIds": ["well-led.governance_management_and_sustainability"], "actionRequired": true}]'::jsonb, 'Harbour starter template, to be reviewed by the tenant (H-760)');
