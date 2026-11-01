CREATE TABLE "medication_error" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"incident_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"medication_id" uuid,
	"administration_id" uuid,
	"kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"stage" text,
	"reached_person" text,
	"controlled_drug" text,
	"deliberate_or_repeated" text,
	"immediate_actions" text,
	"clinician_told_at" timestamp with time zone,
	"clinician_told" text,
	"advice_given" text,
	"root_cause" text,
	"cd_reported_on" date,
	"cd_report_reference" text,
	"retention_class" text DEFAULT 'serious_incident' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medication_error_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_error_incident_key" UNIQUE("tenant_id","incident_id"),
	CONSTRAINT "medication_error_kinds" CHECK (kinds <@ ARRAY['omitted_dose','wrong_dose','wrong_medicine','wrong_person','wrong_time','wrong_route','given_after_stopped','other','wrong_frequency','wrong_formulation','wrong_quantity','allergy_or_contraindication','expired_medicine','wrong_storage','monitoring_not_done','record_unclear_or_missing']::text[] AND cardinality(kinds) <= 16),
	CONSTRAINT "medication_error_stage" CHECK (stage IS NULL OR stage IN ('prescribing','transcribing','dispensing','administration','monitoring','storage','other')),
	CONSTRAINT "medication_error_reached" CHECK (reached_person IS NULL OR reached_person IN ('yes','no','unsure')),
	CONSTRAINT "medication_error_cd" CHECK (controlled_drug IS NULL OR controlled_drug IN ('yes','no','unsure')),
	CONSTRAINT "medication_error_deliberate" CHECK (deliberate_or_repeated IS NULL OR deliberate_or_repeated IN ('yes','no','unsure')),
	CONSTRAINT "medication_error_text" CHECK ((immediate_actions IS NULL OR char_length(immediate_actions) <= 2000)
        AND (advice_given IS NULL OR char_length(advice_given) <= 2000)
        AND (root_cause IS NULL OR char_length(root_cause) <= 2000)
        AND (clinician_told IS NULL OR char_length(btrim(clinician_told)) BETWEEN 1 AND 2000)),
	CONSTRAINT "medication_error_clinician" CHECK ((clinician_told_at IS NULL) = (clinician_told IS NULL)),
	CONSTRAINT "medication_error_cd_report" CHECK ((cd_reported_on IS NULL) = (cd_report_reference IS NULL)
        AND (cd_report_reference IS NULL OR char_length(btrim(cd_report_reference)) BETWEEN 1 AND 120)
        AND (cd_reported_on IS NULL OR controlled_drug IS DISTINCT FROM 'no')),
	CONSTRAINT "medication_error_retention" CHECK (retention_class = 'serious_incident')
);
--> statement-breakpoint
CREATE TABLE "medication_review" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"done_on" date,
	"clinician_name" text,
	"clinician_role" text,
	"outcome" text,
	"recorded_by" uuid,
	"correction_reason" text,
	"retention_class" text DEFAULT 'mar_chart' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medication_review_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_review_done" CHECK ((done_on IS NULL) = (clinician_name IS NULL)
        AND (done_on IS NULL) = (clinician_role IS NULL)
        AND (done_on IS NULL) = (outcome IS NULL)
        AND (done_on IS NULL) = (recorded_by IS NULL)),
	CONSTRAINT "medication_review_role" CHECK (clinician_role IS NULL OR clinician_role IN ('gp','pharmacist','prescriber','consultant','other')),
	CONSTRAINT "medication_review_text" CHECK ((clinician_name IS NULL OR char_length(btrim(clinician_name)) BETWEEN 1 AND 200)
        AND (outcome IS NULL OR char_length(btrim(outcome)) BETWEEN 1 AND 4000)
        AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 1 AND 500)),
	CONSTRAINT "medication_review_retention" CHECK (retention_class = 'mar_chart')
);
--> statement-breakpoint
ALTER TABLE "medication_error" ADD CONSTRAINT "medication_error_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_error" ADD CONSTRAINT "medication_error_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_error" ADD CONSTRAINT "medication_error_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_error" ADD CONSTRAINT "medication_error_administration_fk" FOREIGN KEY ("tenant_id","person_id","administration_id") REFERENCES "public"."medication_administration"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_review" ADD CONSTRAINT "medication_review_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_review" ADD CONSTRAINT "medication_review_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Medication errors and reviews security (slice 45; medicines.md section 14; ADR-0002 patterns).
-- Runs as harbour_owner. An error follows its incident's scope and its person's; a review its
-- person's.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medication_error', 'medication_review'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY incident_child_scope ON public.medication_error AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.incident_visible(incident_id)) WITH CHECK (app.incident_visible(incident_id));
--> statement-breakpoint
-- An error belongs to a medication incident and one of its people; neither ever changes.
CREATE OR REPLACE FUNCTION app.medication_error_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.incident_id IS DISTINCT FROM OLD.incident_id
       OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RAISE EXCEPTION 'medication_error_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.incident i
    WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.incident_id AND i.type = 'medication'
      AND NEW.person_id = ANY (i.person_ids)
  ) THEN
    RAISE EXCEPTION 'medication_error_not_on_incident' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_error_guard BEFORE INSERT OR UPDATE ON public.medication_error
  FOR EACH ROW EXECUTE FUNCTION app.medication_error_guard();
--> statement-breakpoint
-- A review is the person's for good; once done, any change needs a new correction reason.
CREATE OR REPLACE FUNCTION app.medication_review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'medication_review_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.done_on IS NOT NULL
     AND (NEW.due_on, NEW.done_on, NEW.clinician_name, NEW.clinician_role, NEW.outcome, NEW.deleted_at)
         IS DISTINCT FROM
         (OLD.due_on, OLD.done_on, OLD.clinician_name, OLD.clinician_role, OLD.outcome, OLD.deleted_at)
     AND (NEW.correction_reason IS NULL OR NEW.correction_reason IS NOT DISTINCT FROM OLD.correction_reason) THEN
    RAISE EXCEPTION 'medication_review_done_needs_reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_review_guard BEFORE UPDATE ON public.medication_review
  FOR EACH ROW EXECUTE FUNCTION app.medication_review_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.medication_error
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.medication_error
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.medication_review
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.medication_review
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.medication_error, public.medication_review TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.medication_error, public.medication_review FROM harbour_app;
--> statement-breakpoint
-- Errors and reviews stay on the server (no PowerSync publication).

-- Sample data mode (migration 0069, HZ-072): a sample person's errors and reviews go with them,
-- before the entries and records they reference. Every table migration 0123 listed is kept.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'medication_error', 'medication_review',
    'medication_administration_witness', 'medication_administration', 'medication_dosing_record',
    'medication_reconciliation_decision', 'medication_reconciliation_item',
    'medication_reconciliation_source', 'medication_schedule', 'medication',
    'medication_reconciliation',
    'dependency_assessment',
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'safeguarding_concern', 'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.medication_error, public.medication_review TO harbour_sample_owner;
