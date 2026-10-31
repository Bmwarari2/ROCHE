CREATE TABLE "medication_administration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"reason_code" text,
	"reason_note" text,
	"quantity" numeric(12, 3),
	"unit_code" text,
	"prescribed" jsonb,
	"dosing_record_id" uuid,
	"amount_difference_reason" text,
	"timing_reason" text,
	"interval_override_reason" text,
	"given_before_recorded_reason" text,
	"given_at" timestamp with time zone NOT NULL,
	"device_at" timestamp with time zone,
	"device_offset_ms" integer,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"competence_override" jsonb,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"scan_evidence" jsonb,
	"cd_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medication_administration_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_administration_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "medication_administration_outcome" CHECK (outcome IN ('given','refused','not_given','not_available','self_administered','given_by_family','withheld')),
	CONSTRAINT "medication_administration_amount" CHECK ((quantity IS NULL AND unit_code IS NULL)
       OR (quantity > 0 AND length(btrim(coalesce(unit_code, ''))) > 0)),
	CONSTRAINT "medication_administration_given" CHECK (outcome <> 'given' OR quantity IS NOT NULL),
	CONSTRAINT "medication_administration_correction" CHECK ((supersedes_id IS NULL AND correction_reason IS NULL)
       OR (supersedes_id IS NOT NULL AND supersedes_id <> id
           AND length(btrim(coalesce(correction_reason, ''))) > 0)),
	CONSTRAINT "medication_administration_given_before_recorded" CHECK (given_before_recorded_reason IS NULL
       OR (length(btrim(given_before_recorded_reason)) > 0 AND given_at < recorded_at)),
	CONSTRAINT "medication_administration_flags" CHECK (flags <@ ARRAY['early', 'late', 'interval_override', 'competence_override',
        'amount_differs', 'entry_not_yet_checked', 'other_unit_not_counted', 'over_maximum',
        'before_window', 'earlier_dose_outstanding', 'entry_not_usable', 'no_usable_dosing_record',
        'amount_in_other_unit', 'competence_not_current', 'given_before_recorded',
        'clock_drift']::text[])
);
--> statement-breakpoint
CREATE TABLE "medication_administration_witness" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"administration_id" uuid NOT NULL,
	"witness_id" uuid NOT NULL,
	"witnessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medication_administration_witness_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_administration_witness_once_key" UNIQUE("tenant_id","administration_id"),
	CONSTRAINT "medication_administration_witness_method" CHECK (method IN ('step_up', 'device_factor'))
);
--> statement-breakpoint
CREATE TABLE "medication_dosing_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_reference" text NOT NULL,
	"source_document_id" uuid,
	"doses" jsonb NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_by" uuid,
	"check_at" timestamp with time zone,
	"check_outcome" text,
	"check_difference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "medication_dosing_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_dosing_record_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "medication_dosing_record_source_kind" CHECK (source_kind IN ('prescription','pharmacy_label','pharmacy_mar','discharge_letter','transfer_letter','gp_record','clinic_letter','prescriber_instruction','previous_mar')),
	CONSTRAINT "medication_dosing_record_source_reference" CHECK (length(btrim(source_reference)) > 0),
	CONSTRAINT "medication_dosing_record_doses" CHECK (jsonb_typeof(doses) = 'array' AND jsonb_array_length(doses) > 0),
	CONSTRAINT "medication_dosing_record_check" CHECK ((check_by IS NULL AND check_at IS NULL AND check_outcome IS NULL AND check_difference IS NULL)
       OR (check_by IS NOT NULL AND check_at IS NOT NULL AND check_by <> recorded_by
           AND ((check_outcome = 'matches_source' AND check_difference IS NULL)
             OR (check_outcome = 'differs_from_source'
                 AND length(btrim(coalesce(check_difference, ''))) > 0))))
);
--> statement-breakpoint
ALTER TABLE "medication" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "medication" ADD COLUMN "minimum_interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "medication" ADD COLUMN "prn_max_per_24h" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_dosing_record_fk" FOREIGN KEY ("tenant_id","person_id","dosing_record_id") REFERENCES "public"."medication_dosing_record"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."medication_administration"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration_witness" ADD CONSTRAINT "medication_administration_witness_administration_fk" FOREIGN KEY ("tenant_id","person_id","administration_id") REFERENCES "public"."medication_administration"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administration_witness" ADD CONSTRAINT "medication_administration_witness_member_fk" FOREIGN KEY ("tenant_id","witness_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dosing_record" ADD CONSTRAINT "medication_dosing_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dosing_record" ADD CONSTRAINT "medication_dosing_record_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dosing_record" ADD CONSTRAINT "medication_dosing_record_document_fk" FOREIGN KEY ("tenant_id","person_id","source_document_id") REFERENCES "public"."document"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dosing_record" ADD CONSTRAINT "medication_dosing_record_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dosing_record" ADD CONSTRAINT "medication_dosing_record_check_by_fk" FOREIGN KEY ("tenant_id","check_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "medication_administration_dose_key" ON "medication_administration" USING btree ("tenant_id","medication_id","due_at") WHERE supersedes_id IS NULL AND due_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "medication_administration_supersedes_key" ON "medication_administration" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "medication_administration_person_idx" ON "medication_administration" USING btree ("tenant_id","person_id","given_at");--> statement-breakpoint
CREATE INDEX "medication_dosing_record_entry_idx" ON "medication_dosing_record" USING btree ("tenant_id","medication_id");--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_tags" CHECK (tags <@ ARRAY['time_critical', 'paracetamol', 'bisphosphonate', 'psychotropic']::text[]);--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_minimum_interval" CHECK (minimum_interval_minutes IS NULL OR minimum_interval_minutes > 0);--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_prn_max" CHECK (prn_max_per_24h IS NULL OR (directions = 'when_required' AND prn_max_per_24h > 0));--> statement-breakpoint
-- Administrations security (ADR-0002 patterns; medicines.md section 13; slice 22). Runs as
-- harbour_owner. Every row is about one person and follows that person's scope.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medication_dosing_record', 'medication_administration',
      'medication_administration_witness'] LOOP
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

-- Rule 13's tags, minimum interval and 24-hour maximum are part of what a version says (HZ-004,
-- HZ-005): set at transcription, never changed (a change is a new version).
CREATE OR REPLACE FUNCTION app.medication_rule13_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tags, NEW.minimum_interval_minutes, NEW.prn_max_per_24h)
     IS DISTINCT FROM (OLD.tags, OLD.minimum_interval_minutes, OLD.prn_max_per_24h) THEN
    RAISE EXCEPTION 'medication: tags, interval and maximum never change; record a new version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_rule13_fixed BEFORE UPDATE ON public.medication
  FOR EACH ROW EXECUTE FUNCTION app.medication_rule13_fixed();
--> statement-breakpoint

-- A dosing record says what its source says (HZ-005, HZ-116): its content never changes, its check
-- is set once, its time is the server's, and the application never removes it.
CREATE OR REPLACE FUNCTION app.medication_dosing_record_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.recorded_at := now();
    IF NEW.check_by IS NOT NULL THEN
      RAISE EXCEPTION 'medication_dosing_record: a new record is not yet checked'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.person_id, NEW.medication_id, NEW.source_kind,
      NEW.source_reference, NEW.source_document_id, NEW.doses, NEW.recorded_by, NEW.recorded_at,
      NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.person_id, OLD.medication_id, OLD.source_kind,
      OLD.source_reference, OLD.source_document_id, OLD.doses, OLD.recorded_by, OLD.recorded_at,
      OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'medication_dosing_record: what it says never changes; record a new one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.check_at IS NOT NULL
     AND (NEW.check_by, NEW.check_at, NEW.check_outcome, NEW.check_difference)
         IS DISTINCT FROM (OLD.check_by, OLD.check_at, OLD.check_outcome, OLD.check_difference) THEN
    RAISE EXCEPTION 'medication_dosing_record: the second check is recorded once'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(app.current_user_id(), NEW.updated_by);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_dosing_record_write_once
  BEFORE INSERT OR UPDATE ON public.medication_dosing_record
  FOR EACH ROW EXECUTE FUNCTION app.medication_dosing_record_write_once();
--> statement-breakpoint

-- An administration is stored at the server's time (the MAR row locks from then), and a
-- correction stays with the person, entry version and dose of the record it corrects (rule 23).
CREATE OR REPLACE FUNCTION app.medication_administration_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE original public.medication_administration;
BEGIN
  NEW.recorded_at := now();
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO original FROM public.medication_administration o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.supersedes_id;
    IF NOT FOUND OR original.person_id <> NEW.person_id
       OR original.medication_id <> NEW.medication_id
       OR original.due_at IS DISTINCT FROM NEW.due_at THEN
      RAISE EXCEPTION 'medication_administration: a correction stays with its record''s dose'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_administration_insert BEFORE INSERT ON public.medication_administration
  FOR EACH ROW EXECUTE FUNCTION app.medication_administration_insert();
--> statement-breakpoint

-- The witness is a second person (ADR-0084): never the member who recorded the dose.
CREATE OR REPLACE FUNCTION app.medication_administration_witness_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.witnessed_at := now();
  IF EXISTS (SELECT 1 FROM public.medication_administration a
              WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.administration_id
                AND a.recorded_by = NEW.witness_id) THEN
    RAISE EXCEPTION 'medication_administration_witness: the witness is not the recorder'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_administration_witness_insert
  BEFORE INSERT ON public.medication_administration_witness
  FOR EACH ROW EXECUTE FUNCTION app.medication_administration_witness_insert();
--> statement-breakpoint

-- Administrations and witnesses are append-only (section 5.5): a correction is a new row.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medication_administration', 'medication_administration_witness'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

GRANT SELECT, INSERT ON public.medication_administration, public.medication_administration_witness
  TO harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.medication_dosing_record TO harbour_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.medication_administration,
  public.medication_administration_witness FROM harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.medication_dosing_record FROM harbour_app;
--> statement-breakpoint
-- Not published to devices yet: the round stream is a contract (medicines.md 13.8, slice 68).

-- Sample data mode (migration 0069, HZ-072): a sample person's administrations go with them,
-- before the entries they reference. Every table migration 0111 listed is kept.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
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
$$;--> statement-breakpoint
GRANT SELECT, DELETE ON public.medication_administration, public.medication_administration_witness,
  public.medication_dosing_record TO harbour_sample_owner;
