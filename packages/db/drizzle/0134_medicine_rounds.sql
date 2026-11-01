CREATE TABLE "medication_administration_conflict" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"client_record_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"standing_id" uuid NOT NULL,
	"uploaded" jsonb NOT NULL,
	"problems" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_at" timestamp with time zone,
	"device_offset_ms" integer,
	"uploaded_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"correction_id" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "medication_administration_conflict_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_administration_conflict_client_key" UNIQUE("tenant_id","client_record_id"),
	CONSTRAINT "medication_administration_conflict_resolution" CHECK ((resolved_by IS NULL AND resolved_at IS NULL AND resolution IS NULL AND correction_id IS NULL
           AND resolution_note IS NULL)
       OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL
           AND length(btrim(coalesce(resolution_note, ''))) > 0
           AND ((resolution IN ('first_stands', 'both_given') AND correction_id IS NULL)
             OR (resolution = 'corrected' AND correction_id IS NOT NULL))))
);--> statement-breakpoint
ALTER TABLE "medication_administration" DROP CONSTRAINT "medication_administration_flags";--> statement-breakpoint
ALTER TABLE "medication_administration_conflict" ADD CONSTRAINT "medication_administration_conflict_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration_conflict" ADD CONSTRAINT "medication_administration_conflict_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration_conflict" ADD CONSTRAINT "medication_administration_conflict_standing_fk" FOREIGN KEY ("tenant_id","person_id","standing_id") REFERENCES "public"."medication_administration"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration_conflict" ADD CONSTRAINT "medication_administration_conflict_correction_fk" FOREIGN KEY ("tenant_id","person_id","correction_id") REFERENCES "public"."medication_administration"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration_conflict" ADD CONSTRAINT "medication_administration_conflict_uploaded_by_fk" FOREIGN KEY ("tenant_id","uploaded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration_conflict" ADD CONSTRAINT "medication_administration_conflict_resolved_by_fk" FOREIGN KEY ("tenant_id","resolved_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medication_administration_conflict_open_idx" ON "medication_administration_conflict" USING btree ("tenant_id","person_id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "medication_administration_conflict_open_dose_key" ON "medication_administration_conflict" USING btree ("tenant_id","person_id","medication_id","due_at","uploaded_by") WHERE resolved_at IS NULL;--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_flags" CHECK (flags <@ ARRAY['early', 'late', 'interval_override', 'competence_override',
        'amount_differs', 'entry_not_yet_checked', 'other_unit_not_counted', 'over_maximum',
        'before_window', 'earlier_dose_outstanding', 'entry_not_usable', 'no_usable_dosing_record',
        'amount_in_other_unit', 'competence_not_current', 'given_before_recorded',
        'given_by_someone_else', 'close_to_last_dose', 'clock_drift', 'corrected',
        'dose_removed', 'dose_moved', 'breach_created', 'breach_hidden', 'close_to_next_dose',
        'inside_minimum_interval', 'differs_when_recorded']::text[]);
--> statement-breakpoint
-- Conflict review security (ADR-0002 patterns; medicines.md 15.4; slice 48). Runs as harbour_owner.
ALTER TABLE public.medication_administration_conflict ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.medication_administration_conflict FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.medication_administration_conflict AS PERMISSIVE FOR ALL
  TO PUBLIC USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY person_child_scope ON public.medication_administration_conflict AS RESTRICTIVE
  FOR ALL TO harbour_app, harbour_owner
  USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id));--> statement-breakpoint

-- What a conflict holds never changes (the upload as sent, the record that stands); its
-- resolution is set once. The server stamps when it arrived and when it was resolved.
CREATE OR REPLACE FUNCTION app.medication_administration_conflict_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.received_at := now();
    IF NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'medication_administration_conflict: a new conflict is open'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.person_id, NEW.client_record_id, NEW.medication_id, NEW.due_at,
      NEW.standing_id, NEW.uploaded, NEW.problems, NEW.device_at, NEW.device_offset_ms,
      NEW.uploaded_by, NEW.received_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.person_id, OLD.client_record_id, OLD.medication_id, OLD.due_at,
      OLD.standing_id, OLD.uploaded, OLD.problems, OLD.device_at, OLD.device_offset_ms,
      OLD.uploaded_by, OLD.received_at, OLD.created_at)
     OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'medication_administration_conflict: what it holds never changes; it is resolved once'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.resolved_at := now();
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(app.current_user_id(), NEW.updated_by);
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER medication_administration_conflict_guard
  BEFORE INSERT OR UPDATE ON public.medication_administration_conflict
  FOR EACH ROW EXECUTE FUNCTION app.medication_administration_conflict_guard();--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.medication_administration_conflict TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.medication_administration_conflict FROM harbour_app;--> statement-breakpoint

-- Sample data mode (migration 0069, HZ-072): a sample person's conflicts go before the records
-- they name. The list is migration 0099's (main) with every medicines table first, so the tables
-- main added (0093, 0099) and the medicines tables (0111 to 0134) are all kept.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'medication_administration_conflict', 'controlled_drug_stock_check', 'controlled_drug_entry',
    'controlled_drug_witness_assertion', 'controlled_drug_page',
    'medication_administration_witness', 'medication_administration', 'medication_dosing_record',
    'medication_reconciliation_decision', 'medication_reconciliation_item',
    'medication_reconciliation_source', 'medication_schedule', 'medication',
    'medication_reconciliation',
    'death_step', 'missing_event', 'death_record', 'missing_episode', 'herbert_profile',
    'outbreak_case', 'dependency_assessment',
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
$$;--> statement-breakpoint
GRANT SELECT, DELETE ON public.medication_administration_conflict TO harbour_sample_owner;
