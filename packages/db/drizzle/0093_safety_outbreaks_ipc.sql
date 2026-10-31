CREATE TABLE "ipc_code_criterion" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "ipc_code_criterion_number_key" UNIQUE("number"),
	CONSTRAINT "ipc_code_criterion_number" CHECK (number BETWEEN 1 AND 10 AND id = 'criterion_' || number)
);
--> statement-breakpoint
CREATE TABLE "outbreak" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"syndrome" text NOT NULL,
	"organism" text,
	"state" text DEFAULT 'declared' NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"declared_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"notification_id" uuid,
	"hpt_reference" text,
	"closed_on" date,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "outbreak_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "outbreak_syndrome" CHECK (syndrome IN ('acute_respiratory', 'flu', 'covid_19', 'diarrhoea_vomiting', 'other')),
	CONSTRAINT "outbreak_state" CHECK (state IN ('declared', 'closed')),
	CONSTRAINT "outbreak_organism" CHECK (organism IS NULL OR char_length(organism) BETWEEN 2 AND 200),
	CONSTRAINT "outbreak_hpt_reference" CHECK (hpt_reference IS NULL OR char_length(hpt_reference) BETWEEN 1 AND 100),
	CONSTRAINT "outbreak_closure" CHECK ((state = 'closed') = (closed_on IS NOT NULL AND closed_at IS NOT NULL
        AND closed_by IS NOT NULL AND closure_reason IS NOT NULL)
        AND (closure_reason IS NULL OR char_length(btrim(closure_reason)) BETWEEN 3 AND 1000))
);
--> statement-breakpoint
CREATE TABLE "outbreak_case" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"outbreak_id" uuid NOT NULL,
	"case_type" text NOT NULL,
	"person_id" uuid,
	"tenant_user_id" uuid,
	"onset_on" date NOT NULL,
	"symptoms" text[] NOT NULL,
	"test_type" text,
	"tested_on" date,
	"test_result" text NOT NULL,
	"flu_vaccinated" text NOT NULL,
	"covid_vaccinated" text NOT NULL,
	"outcome" text NOT NULL,
	"outcome_on" date,
	"supersedes_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "outbreak_case_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "outbreak_case_type" CHECK (case_type IN ('resident', 'staff')),
	CONSTRAINT "outbreak_case_subject" CHECK ((case_type = 'resident' AND person_id IS NOT NULL AND tenant_user_id IS NULL)
        OR (case_type = 'staff' AND tenant_user_id IS NOT NULL AND person_id IS NULL)),
	CONSTRAINT "outbreak_case_symptoms" CHECK (cardinality(symptoms) BETWEEN 1 AND 9
        AND symptoms <@ ARRAY['fever', 'cough', 'sore_throat', 'shortness_of_breath', 'loss_of_taste_or_smell', 'diarrhoea', 'vomiting', 'new_confusion', 'other']::text[]),
	CONSTRAINT "outbreak_case_test" CHECK (test_result IN ('not_tested', 'pending', 'positive', 'negative')
        AND (test_type IS NULL OR test_type IN ('lateral_flow', 'pcr', 'stool_sample', 'other'))
        AND (test_result = 'not_tested') = (test_type IS NULL AND tested_on IS NULL)
        AND (test_type IS NULL) = (tested_on IS NULL)
        AND (tested_on IS NULL OR tested_on >= onset_on)),
	CONSTRAINT "outbreak_case_vaccination" CHECK (flu_vaccinated IN ('yes', 'no', 'unknown')
        AND covid_vaccinated IN ('yes', 'no', 'unknown')),
	CONSTRAINT "outbreak_case_outcome" CHECK (outcome IN ('unwell', 'recovered', 'hospitalised', 'died')
        AND (outcome = 'unwell') = (outcome_on IS NULL)
        AND (outcome_on IS NULL OR outcome_on >= onset_on)),
	CONSTRAINT "outbreak_case_correction" CHECK ((correction_reason IS NULL OR supersedes_id IS NOT NULL)
        AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500))
);
--> statement-breakpoint
ALTER TABLE "outbreak" ADD CONSTRAINT "outbreak_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbreak" ADD CONSTRAINT "outbreak_declared_by_fk" FOREIGN KEY ("tenant_id","declared_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbreak" ADD CONSTRAINT "outbreak_notification_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."statutory_notification"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbreak_case" ADD CONSTRAINT "outbreak_case_outbreak_fk" FOREIGN KEY ("tenant_id","outbreak_id") REFERENCES "public"."outbreak"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbreak_case" ADD CONSTRAINT "outbreak_case_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbreak_case" ADD CONSTRAINT "outbreak_case_tenant_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbreak_case" ADD CONSTRAINT "outbreak_case_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."outbreak_case"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbreak_one_open" ON "outbreak" USING btree ("tenant_id","location_id","syndrome") WHERE state = 'declared';--> statement-breakpoint
CREATE UNIQUE INDEX "outbreak_notification_once" ON "outbreak" USING btree ("tenant_id","notification_id") WHERE notification_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "outbreak_case_superseded_once" ON "outbreak_case" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbreak_case_outbreak_idx" ON "outbreak_case" USING btree ("tenant_id","outbreak_id");--> statement-breakpoint
-- Outbreak management and IPC audits (safety.md section 11; SAFE-013; HZ-013). Runs as harbour_owner.

-- The Code of Practice criteria IPC audits are read against: global reference data, read by every
-- role and written only here, in Harbour's summary of each criterion (to be checked, H-765).
ALTER TABLE public.ipc_code_criterion ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ipc_code_criterion FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY global_read ON public.ipc_code_criterion AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
--> statement-breakpoint
CREATE POLICY owner_maintenance ON public.ipc_code_criterion AS PERMISSIVE FOR ALL TO harbour_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ipc_code_criterion FROM harbour_app, harbour_worker;
--> statement-breakpoint
GRANT SELECT ON public.ipc_code_criterion TO harbour_app, harbour_worker;
--> statement-breakpoint
INSERT INTO public.ipc_code_criterion (id, number, title, source) VALUES
  ('criterion_1', 1, 'Systems to manage and monitor infection prevention and control, using risk assessments', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_2', 2, 'A clean environment that helps prevent and control infections', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_3', 3, 'Appropriate antimicrobial use and stewardship', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_4', 4, 'Accurate information on infections given in good time to others providing care', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_5', 5, 'People with or at risk of an infection are identified promptly and cared for to reduce spread', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_6', 6, 'All care workers know and carry out their part in preventing and controlling infection', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_7', 7, 'Adequate isolation precautions and facilities', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_8', 8, 'Adequate access to laboratory and diagnostic support', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_9', 9, 'Policies that help prevent and control infections, and are followed', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)'),
  ('criterion_10', 10, 'Staff health and wellbeing, and the organisation''s duty to manage infection prevention', 'DHSC, The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance (summary to be checked, H-765)');
--> statement-breakpoint

-- The IPC starter template (slice 19) covers all ten criteria, each question mapped to the
-- criteria it evidences. Organisations' own copies keep what they copied.
UPDATE public.audit_starter_template
   SET questions = '[{"key": "ipc_lead", "text": "A named IPC lead is in place, and the IPC risk assessment was reviewed when the policy says", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "well-led.governance_management_and_sustainability"], "actionRequired": true, "ipcCriteria": ["criterion_1"]}, {"key": "hand_hygiene", "text": "Staff observed washing or sanitising their hands at the right moments", "weight": 2, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true, "ipcCriteria": ["criterion_6", "criterion_9"]}, {"key": "ppe", "text": "Personal protective equipment is available where care is given, and used correctly", "weight": 1, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true, "ipcCriteria": ["criterion_6", "criterion_9"]}, {"key": "cleaning", "text": "Cleaning schedules are complete for the last 7 days", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "safe.safe_environments"], "actionRequired": true, "ipcCriteria": ["criterion_2"]}, {"key": "laundry", "text": "Soiled laundry is kept apart from clean, in the right bags", "weight": 1, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true, "ipcCriteria": ["criterion_2"]}, {"key": "sharps", "text": "Sharps bins are in date, not overfilled and stored safely", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "safe.safe_environments"], "actionRequired": true, "ipcCriteria": ["criterion_2", "criterion_9"]}, {"key": "antimicrobials", "text": "Antibiotic courses are given as prescribed, and reviewed with the prescriber when due", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "safe.medicines_optimisation"], "actionRequired": true, "ipcCriteria": ["criterion_3"]}, {"key": "infection_status_shared", "text": "A person''s infection status goes with them when they move between services", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "safe.safe_systems_pathways_and_transitions"], "actionRequired": true, "ipcCriteria": ["criterion_4"]}, {"key": "signs_escalated", "text": "New signs of infection are recorded and escalated the same day", "weight": 1, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true, "ipcCriteria": ["criterion_5"]}, {"key": "training", "text": "Staff IPC training is in date", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "safe.safe_and_effective_staffing"], "actionRequired": true, "ipcCriteria": ["criterion_6"]}, {"key": "isolation", "text": "A person can be isolated when needed, with the room, equipment and signage ready", "weight": 1, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true, "ipcCriteria": ["criterion_7"]}, {"key": "specimens", "text": "Specimens can be taken and sent for testing, and results are followed up", "weight": 1, "statementIds": ["safe.infection_prevention_and_control"], "actionRequired": true, "ipcCriteria": ["criterion_8"]}, {"key": "staff_health", "text": "Staff know when to stay away from work with an infection, and vaccination is offered", "weight": 1, "statementIds": ["safe.infection_prevention_and_control", "caring.workforce_wellbeing_and_enablement"], "actionRequired": true, "ipcCriteria": ["criterion_10"]}]'::jsonb
 WHERE key = 'ipc';
--> statement-breakpoint

-- Tenant isolation, and outbreaks only for those who manage outbreaks at the location. A case is
-- seen through its outbreak, and a resident's case only by those who can see the person.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbreak', 'outbreak_case'] LOOP
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
CREATE POLICY outbreak_location ON public.outbreak AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.is_system() OR app.holds_permission_at('safety.outbreak.manage', location_id))
  WITH CHECK (app.is_system() OR app.holds_permission_at('safety.outbreak.manage', location_id));
--> statement-breakpoint
CREATE POLICY outbreak_case_scope ON public.outbreak_case AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.is_system() OR (
    EXISTS (SELECT 1 FROM public.outbreak o WHERE o.id = outbreak_id
            AND app.holds_permission_at('safety.outbreak.manage', o.location_id))
    AND (person_id IS NULL OR app.person_visible(person_id))))
  WITH CHECK (app.is_system() OR (
    EXISTS (SELECT 1 FROM public.outbreak o WHERE o.id = outbreak_id
            AND app.holds_permission_at('safety.outbreak.manage', o.location_id))
    AND (person_id IS NULL OR app.person_visible(person_id))));
--> statement-breakpoint

-- An outbreak is declared in its declarer's name; its place, illness and declaration never change;
-- its UKHSA report is linked once; it closes once, with who and when recorded, and only once that
-- report is decided (HZ-013). A closed outbreak never changes.
CREATE OR REPLACE FUNCTION app.outbreak_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'declared' OR NEW.deleted_at IS NOT NULL
       OR (app.current_user_id() IS NOT NULL AND NEW.declared_by IS DISTINCT FROM app.current_user_id()) THEN
      RAISE EXCEPTION 'An outbreak is declared open, in its declarer''s name'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.declared_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'closed' THEN
    RAISE EXCEPTION 'A closed outbreak never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.tenant_id, NEW.location_id, NEW.syndrome, NEW.declared_at, NEW.declared_by, NEW.deleted_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.location_id, OLD.syndrome, OLD.declared_at, OLD.declared_by,
       OLD.deleted_at)
     OR (OLD.notification_id IS NOT NULL AND NEW.notification_id IS DISTINCT FROM OLD.notification_id) THEN
    RAISE EXCEPTION 'An outbreak keeps its place, illness, declaration and report'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'closed' THEN
    IF NEW.closed_on > (now() AT TIME ZONE 'Europe/London')::date
       OR NEW.closed_on < (OLD.declared_at AT TIME ZONE 'Europe/London')::date THEN
      RAISE EXCEPTION 'An outbreak closes on or after its declaration, and not in the future'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.notification_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.statutory_notification n
          WHERE n.id = NEW.notification_id AND n.status IN ('submitted', 'not_required')) THEN
      RAISE EXCEPTION 'An outbreak closes only once its report is submitted or recorded as not needed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.closed_at := now();
    NEW.closed_by := coalesce(app.current_user_id(), NEW.closed_by);
  ELSIF num_nonnulls(NEW.closed_on, NEW.closed_at, NEW.closed_by, NEW.closure_reason) > 0 THEN
    RAISE EXCEPTION 'Only closing an outbreak records its closure'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER outbreak_guard BEFORE INSERT OR UPDATE ON public.outbreak
  FOR EACH ROW EXECUTE FUNCTION app.outbreak_guard();
--> statement-breakpoint

-- A case joins an open outbreak: a resident of the outbreak's location, or a member of staff who
-- works there (a current role there or across the organisation), once per outbreak; nothing dated
-- in the future (UK dates). A later row supersedes the person's row and follows it, whatever has
-- happened to the person since (discharged, moved, left), so an outcome can still be recorded.
CREATE OR REPLACE FUNCTION app.outbreak_case_add() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o public.outbreak;
  prior public.outbreak_case;
  today date := (now() AT TIME ZONE 'Europe/London')::date;
BEGIN
  SELECT * INTO o FROM public.outbreak WHERE id = NEW.outbreak_id;
  IF o.id IS NULL OR o.state <> 'declared' THEN
    RAISE EXCEPTION 'A case joins an open outbreak' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF greatest(NEW.onset_on, NEW.tested_on, NEW.outcome_on) > today THEN
    RAISE EXCEPTION 'A case is not dated in the future' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO prior FROM public.outbreak_case WHERE id = NEW.supersedes_id;
    IF prior.id IS NULL OR (prior.outbreak_id, prior.case_type, prior.person_id, prior.tenant_user_id)
       IS DISTINCT FROM (NEW.outbreak_id, NEW.case_type, NEW.person_id, NEW.tenant_user_id) THEN
      RAISE EXCEPTION 'An update supersedes the same person''s case on the same outbreak'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.case_type = 'resident' AND NOT EXISTS (
       SELECT 1 FROM public.person p WHERE p.id = NEW.person_id AND p.location_id = o.location_id) THEN
    RAISE EXCEPTION 'A resident case is someone living at the outbreak''s location'
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.case_type = 'staff' AND NOT EXISTS (
       SELECT 1 FROM public.role_assignment ra
        WHERE ra.tenant_user_id = NEW.tenant_user_id
          AND (ra.location_id = o.location_id OR ra.location_id IS NULL)
          AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())) THEN
    RAISE EXCEPTION 'A staff case is someone working at the outbreak''s location'
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF EXISTS (SELECT 1 FROM public.outbreak_case c
                 WHERE c.outbreak_id = NEW.outbreak_id
                   AND c.person_id IS NOT DISTINCT FROM NEW.person_id
                   AND c.tenant_user_id IS NOT DISTINCT FROM NEW.tenant_user_id) THEN
    RAISE EXCEPTION 'This person is already on the line list: update their case instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER outbreak_case_add BEFORE INSERT ON public.outbreak_case
  FOR EACH ROW EXECUTE FUNCTION app.outbreak_case_add();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.outbreak_case
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.outbreak_case
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.outbreak
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.outbreak
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.outbreak
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.outbreak TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.outbreak FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.outbreak_case TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.outbreak_case FROM harbour_app;
--> statement-breakpoint

-- Removing a sample batch removes its people's outbreak cases too (the list from migration 0069,
-- with outbreak_case first: nothing refers to it but itself).
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'outbreak_case',
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.outbreak_case TO harbour_sample_owner;
--> statement-breakpoint

-- Data migration: existing tenants' copies of the built-in roles gain safety.outbreak.manage as
-- the built-in definitions (packages/domain/src/platform/roles.ts) now hold it: the owner, the
-- Registered Manager, the deputy and the clinical lead. Each change is a new version of the role,
-- made in that tenant's context and audited (platform.role.permissions_migrated). Idempotent.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['safety.outbreak.manage']),
        ('registered_manager', ARRAY['safety.outbreak.manage']),
        ('deputy_manager', ARRAY['safety.outbreak.manage']),
        ('clinical_lead', ARRAY['safety.outbreak.manage'])
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
        jsonb_build_object('migration', '0093_safety_outbreaks_ipc', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the outbreak permission their built-in definitions added (migration 0093)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
