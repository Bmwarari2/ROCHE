CREATE TABLE "medication" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"medicine_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"replaces_id" uuid,
	"state" text DEFAULT 'not_yet_checked' NOT NULL,
	"origin" text NOT NULL,
	"vmp_id" text NOT NULL,
	"amp_id" text,
	"product_name" text NOT NULL,
	"route_code" text NOT NULL,
	"route_name" text NOT NULL,
	"directions" text NOT NULL,
	"pattern_kind" text,
	"interval_days" integer,
	"weekdays" text[],
	"interval_weeks" integer,
	"anchor_on" date,
	"day_of_month" integer,
	"prn_dose" jsonb,
	"indication" text,
	"special_instructions" text,
	"prescriber" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"stops_at" timestamp with time zone,
	"review_on" date,
	"source_kind" text NOT NULL,
	"source_reference" text NOT NULL,
	"source_document_id" uuid,
	"transcribed_by" uuid NOT NULL,
	"transcribed_at" timestamp with time zone NOT NULL,
	"check_by" uuid,
	"check_at" timestamp with time zone,
	"check_outcome" text,
	"check_difference" text,
	"stop_by" uuid,
	"stop_at" timestamp with time zone,
	"stop_effective_at" timestamp with time zone,
	"stop_reason" text,
	"stop_source_kind" text,
	"stop_source_reference" text,
	"stop_source_document_id" uuid,
	"replaced_by_id" uuid,
	"replaced_from" timestamp with time zone,
	"reanchor_by" uuid,
	"reanchor_at" timestamp with time zone,
	"reanchor_reason" text,
	"withdrawn_by" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"corrected_part_way_through" date,
	"earlier_doses_due_on" date,
	"earlier_doses_due_reason" text,
	"cd_schedule" text,
	"reconciliation_id" uuid,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medication_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "medication_medicine_version_key" UNIQUE("tenant_id","medicine_id","version"),
	CONSTRAINT "medication_state" CHECK (state IN ('not_yet_checked', 'checked', 'difference_found', 'stopped', 'replaced', 'withdrawn')),
	CONSTRAINT "medication_origin" CHECK (origin IN ('transcribed', 'reconciliation', 'import')),
	CONSTRAINT "medication_version" CHECK (version >= 1 AND (version = 1) = (replaces_id IS NULL)),
	CONSTRAINT "medication_first_version" CHECK ((version = 1) = (medicine_id = id)),
	CONSTRAINT "medication_vmp" CHECK (vmp_id ~ '^[0-9]{6,18}$'),
	CONSTRAINT "medication_amp" CHECK (amp_id IS NULL OR amp_id ~ '^[0-9]{6,18}$'),
	CONSTRAINT "medication_product_name" CHECK (length(btrim(product_name)) > 0),
	CONSTRAINT "medication_route" CHECK (length(btrim(route_code)) > 0 AND length(btrim(route_name)) > 0),
	CONSTRAINT "medication_directions" CHECK (directions IN ('regular', 'when_required')),
	CONSTRAINT "medication_pattern" CHECK ((directions = 'regular' AND prn_dose IS NULL AND (
            (pattern_kind = 'every_day')
         OR (pattern_kind = 'every_n_days' AND interval_days >= 2 AND anchor_on IS NOT NULL)
         OR (pattern_kind = 'weekly' AND interval_weeks >= 1 AND anchor_on IS NOT NULL
             AND cardinality(weekdays) BETWEEN 1 AND 7)
         OR (pattern_kind = 'monthly' AND day_of_month BETWEEN 1 AND 31)))
       OR (directions = 'when_required' AND pattern_kind IS NULL
           AND prn_dose ? 'kind' AND prn_dose->>'kind' IN ('amount', 'range', 'variable')
           AND length(btrim(coalesce(indication, ''))) > 0)),
	CONSTRAINT "medication_prescriber" CHECK (length(btrim(prescriber)) > 0),
	CONSTRAINT "medication_source" CHECK (source_kind IN ('prescription','pharmacy_label','pharmacy_mar','discharge_letter','transfer_letter','gp_record','clinic_letter','prescriber_instruction','previous_mar') AND length(btrim(source_reference)) > 0),
	CONSTRAINT "medication_period" CHECK (stops_at IS NULL OR stops_at > starts_at),
	CONSTRAINT "medication_check" CHECK ((check_by IS NULL AND check_at IS NULL AND check_outcome IS NULL AND check_difference IS NULL)
       OR (check_by IS NOT NULL AND check_at IS NOT NULL AND check_by <> transcribed_by
           AND ((check_outcome = 'matches_source' AND check_difference IS NULL)
             OR (check_outcome = 'differs_from_source' AND length(btrim(coalesce(check_difference, ''))) > 0)))),
	CONSTRAINT "medication_stop" CHECK ((stop_by IS NULL AND stop_at IS NULL AND stop_effective_at IS NULL AND stop_reason IS NULL
           AND stop_source_kind IS NULL AND stop_source_reference IS NULL)
       OR (stop_by IS NOT NULL AND stop_at IS NOT NULL AND stop_effective_at >= stop_at
           AND length(btrim(coalesce(stop_reason, ''))) > 0
           AND stop_source_kind IN ('prescription','pharmacy_label','pharmacy_mar','discharge_letter','transfer_letter','gp_record','clinic_letter','prescriber_instruction','previous_mar') AND length(btrim(coalesce(stop_source_reference, ''))) > 0)),
	CONSTRAINT "medication_replaced" CHECK ((replaced_by_id IS NULL) = (replaced_from IS NULL)),
	CONSTRAINT "medication_reanchor" CHECK ((reanchor_by IS NULL AND reanchor_at IS NULL AND reanchor_reason IS NULL)
       OR (reanchor_by IS NOT NULL AND reanchor_at IS NOT NULL AND length(btrim(coalesce(reanchor_reason, ''))) > 0)),
	CONSTRAINT "medication_withdrawn" CHECK ((withdrawn_by IS NULL AND withdrawn_at IS NULL AND withdrawn_reason IS NULL)
       OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND length(btrim(coalesce(withdrawn_reason, ''))) > 0)),
	CONSTRAINT "medication_earlier_doses" CHECK ((earlier_doses_due_on IS NULL) = (earlier_doses_due_reason IS NULL)
       AND (earlier_doses_due_reason IS NULL OR length(btrim(earlier_doses_due_reason)) > 0)),
	CONSTRAINT "medication_state_matches" CHECK (CASE state
            WHEN 'withdrawn' THEN withdrawn_at IS NOT NULL
            WHEN 'replaced' THEN replaced_by_id IS NOT NULL AND withdrawn_at IS NULL
            WHEN 'stopped' THEN stop_at IS NOT NULL AND withdrawn_at IS NULL
            WHEN 'difference_found' THEN check_outcome = 'differs_from_source' AND withdrawn_at IS NULL
                 AND replaced_by_id IS NULL
            WHEN 'checked' THEN check_outcome = 'matches_source' AND withdrawn_at IS NULL
                 AND replaced_by_id IS NULL
            ELSE check_at IS NULL AND replaced_by_id IS NULL AND withdrawn_at IS NULL
          END),
	CONSTRAINT "medication_origin_link" CHECK ((origin = 'reconciliation') = (reconciliation_id IS NOT NULL)),
	CONSTRAINT "medication_cd_schedule" CHECK (cd_schedule IS NULL OR cd_schedule IN ('1', '2', '3', '4', '4.1', '4.2', '5'))
);
--> statement-breakpoint
CREATE TABLE "medication_reconciliation" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"placement_id" uuid,
	"hospital_transfer_id" uuid,
	"triggered_at" timestamp with time zone NOT NULL,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"entries_at_start" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"allergies_compared" text,
	"person_involved" text,
	"not_involved_reason" text,
	"no_discharge_letter_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medication_reconciliation_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_reconciliation_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "medication_reconciliation_trigger" CHECK ((trigger = 'admission' AND placement_id IS NOT NULL AND hospital_transfer_id IS NULL)
       OR (trigger = 'return_from_hospital' AND hospital_transfer_id IS NOT NULL AND placement_id IS NULL)
       OR (trigger IN ('transfer', 'change') AND placement_id IS NULL AND hospital_transfer_id IS NULL)),
	CONSTRAINT "medication_reconciliation_status" CHECK (status IN ('open', 'completed')),
	CONSTRAINT "medication_reconciliation_completed" CHECK ((status = 'open' AND completed_by IS NULL AND completed_at IS NULL)
       OR (status = 'completed' AND completed_by IS NOT NULL AND completed_at IS NOT NULL
           AND allergies_compared = 'yes'
           AND (person_involved = 'yes'
             OR (person_involved = 'no' AND length(btrim(coalesce(not_involved_reason, ''))) > 0))))
);
--> statement-breakpoint
CREATE TABLE "medication_reconciliation_decision" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"entry_id" uuid,
	"item_id" uuid,
	"kind" text NOT NULL,
	"decision" jsonb NOT NULL,
	"made_entry_id" uuid,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medication_reconciliation_decision_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_reconciliation_decision_target" CHECK ((entry_id IS NOT NULL AND item_id IS NULL AND kind IN ('continue', 'change', 'stop', 'query'))
       OR (item_id IS NOT NULL AND entry_id IS NULL AND kind IN ('start', 'not_started', 'query'))),
	CONSTRAINT "medication_reconciliation_decision_kind_matches" CHECK (decision->>'kind' = kind)
);
--> statement-breakpoint
CREATE TABLE "medication_reconciliation_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"as_written" text NOT NULL,
	"vmp_id" text,
	"amp_id" text,
	"product_name" text,
	"says" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "medication_reconciliation_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_reconciliation_item_rec_key" UNIQUE("tenant_id","person_id","reconciliation_id","id"),
	CONSTRAINT "medication_reconciliation_item_says" CHECK (says IN ('start', 'continue', 'change', 'stop', 'unclear')),
	CONSTRAINT "medication_reconciliation_item_written" CHECK (length(btrim(as_written)) > 0),
	CONSTRAINT "medication_reconciliation_item_product" CHECK ((vmp_id IS NULL AND amp_id IS NULL AND product_name IS NULL)
       OR (vmp_id ~ '^[0-9]{6,18}$' AND (amp_id IS NULL OR amp_id ~ '^[0-9]{6,18}$')
           AND length(btrim(coalesce(product_name, ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "medication_reconciliation_source" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"document_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"current_because" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "medication_reconciliation_source_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_reconciliation_source_rec_key" UNIQUE("tenant_id","person_id","reconciliation_id","id"),
	CONSTRAINT "medication_reconciliation_source_kind" CHECK (kind IN ('prescription','pharmacy_label','pharmacy_mar','discharge_letter','transfer_letter','gp_record','clinic_letter','prescriber_instruction','previous_mar','person_or_family') AND length(btrim(reference)) > 0),
	CONSTRAINT "medication_reconciliation_source_current" CHECK (current_because IS NULL OR length(btrim(current_because)) > 0)
);
--> statement-breakpoint
CREATE TABLE "medication_schedule" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"time" text NOT NULL,
	"dose_kind" text NOT NULL,
	"quantity" numeric(12, 3),
	"from_quantity" numeric(12, 3),
	"to_quantity" numeric(12, 3),
	"unit_code" text NOT NULL,
	"unit_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "medication_schedule_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medication_schedule_position_key" UNIQUE("tenant_id","medication_id","position"),
	CONSTRAINT "medication_schedule_time_key" UNIQUE("tenant_id","medication_id","time"),
	CONSTRAINT "medication_schedule_time" CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "medication_schedule_dose" CHECK ((dose_kind = 'amount' AND quantity > 0 AND from_quantity IS NULL AND to_quantity IS NULL)
       OR (dose_kind = 'range' AND quantity IS NULL AND from_quantity > 0 AND to_quantity > from_quantity)
       OR (dose_kind = 'variable' AND quantity IS NULL AND from_quantity IS NULL AND to_quantity IS NULL)),
	CONSTRAINT "medication_schedule_unit" CHECK (length(btrim(unit_code)) > 0 AND length(btrim(unit_name)) > 0)
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_person_id_key" UNIQUE("tenant_id","person_id","id");
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_medicine_fk" FOREIGN KEY ("tenant_id","person_id","medicine_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_replaces_fk" FOREIGN KEY ("tenant_id","person_id","replaces_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_replaced_by_fk" FOREIGN KEY ("tenant_id","person_id","replaced_by_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_source_document_fk" FOREIGN KEY ("tenant_id","person_id","source_document_id") REFERENCES "public"."document"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_stop_source_document_fk" FOREIGN KEY ("tenant_id","person_id","stop_source_document_id") REFERENCES "public"."document"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_reconciliation_fk" FOREIGN KEY ("tenant_id","person_id","reconciliation_id") REFERENCES "public"."medication_reconciliation"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_transcribed_by_fk" FOREIGN KEY ("tenant_id","transcribed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_check_by_fk" FOREIGN KEY ("tenant_id","check_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_stop_by_fk" FOREIGN KEY ("tenant_id","stop_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_reanchor_by_fk" FOREIGN KEY ("tenant_id","reanchor_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_withdrawn_by_fk" FOREIGN KEY ("tenant_id","withdrawn_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation" ADD CONSTRAINT "medication_reconciliation_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation" ADD CONSTRAINT "medication_reconciliation_placement_fk" FOREIGN KEY ("tenant_id","person_id","placement_id") REFERENCES "public"."placement"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation" ADD CONSTRAINT "medication_reconciliation_transfer_fk" FOREIGN KEY ("tenant_id","person_id","hospital_transfer_id") REFERENCES "public"."hospital_transfer"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation" ADD CONSTRAINT "medication_reconciliation_started_by_fk" FOREIGN KEY ("tenant_id","started_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation" ADD CONSTRAINT "medication_reconciliation_completed_by_fk" FOREIGN KEY ("tenant_id","completed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation_decision" ADD CONSTRAINT "medication_reconciliation_decision_rec_fk" FOREIGN KEY ("tenant_id","person_id","reconciliation_id") REFERENCES "public"."medication_reconciliation"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation_decision" ADD CONSTRAINT "medication_reconciliation_decision_entry_fk" FOREIGN KEY ("tenant_id","person_id","entry_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation_decision" ADD CONSTRAINT "medication_reconciliation_decision_item_fk" FOREIGN KEY ("tenant_id","person_id","reconciliation_id","item_id") REFERENCES "public"."medication_reconciliation_item"("tenant_id","person_id","reconciliation_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation_decision" ADD CONSTRAINT "medication_reconciliation_decision_made_fk" FOREIGN KEY ("tenant_id","person_id","made_entry_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation_decision" ADD CONSTRAINT "medication_reconciliation_decision_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation_item" ADD CONSTRAINT "medication_reconciliation_item_source_fk" FOREIGN KEY ("tenant_id","person_id","reconciliation_id","source_id") REFERENCES "public"."medication_reconciliation_source"("tenant_id","person_id","reconciliation_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation_source" ADD CONSTRAINT "medication_reconciliation_source_rec_fk" FOREIGN KEY ("tenant_id","person_id","reconciliation_id") REFERENCES "public"."medication_reconciliation"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_reconciliation_source" ADD CONSTRAINT "medication_reconciliation_source_document_fk" FOREIGN KEY ("tenant_id","person_id","document_id") REFERENCES "public"."document"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "medication_schedule" ADD CONSTRAINT "medication_schedule_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "medication_person_idx" ON "medication" USING btree ("tenant_id","person_id","vmp_id");
--> statement-breakpoint
CREATE INDEX "medication_reconciliation_idx" ON "medication" USING btree ("tenant_id","reconciliation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "medication_reconciliation_one_open" ON "medication_reconciliation" USING btree ("tenant_id","person_id") WHERE status = 'open' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "medication_reconciliation_decision_entry_key" ON "medication_reconciliation_decision" USING btree ("tenant_id","reconciliation_id","entry_id") WHERE entry_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "medication_reconciliation_decision_item_key" ON "medication_reconciliation_decision" USING btree ("tenant_id","reconciliation_id","item_id") WHERE item_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- Medicines record security (ADR-0002 patterns; medicines.md section 2; slice 16). Runs as
-- harbour_owner. Everything here is about one person and follows that person's scope.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medication', 'medication_schedule', 'medication_reconciliation',
      'medication_reconciliation_source', 'medication_reconciliation_item',
      'medication_reconciliation_decision'] LOOP
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

-- A MAR entry version is a record of what was transcribed (HZ-005): what it says never changes.
-- Only its check, stop, replacement and withdrawal are set later, each once (a stop may be
-- replaced only by an earlier one, rule 6b), and the state follows them (check constraint).
-- A change is a new row; the unique (medicine, version) key is the expected-version check, so two
-- changes from the same version cannot both land.
CREATE OR REPLACE FUNCTION app.medication_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.person_id, NEW.medicine_id, NEW.version, NEW.replaces_id,
      NEW.origin, NEW.vmp_id, NEW.amp_id, NEW.product_name, NEW.route_code, NEW.route_name,
      NEW.directions, NEW.pattern_kind, NEW.interval_days, NEW.weekdays, NEW.interval_weeks,
      NEW.anchor_on, NEW.day_of_month, NEW.prn_dose, NEW.indication, NEW.special_instructions,
      NEW.prescriber, NEW.starts_at, NEW.stops_at, NEW.review_on, NEW.source_kind,
      NEW.source_reference, NEW.source_document_id, NEW.transcribed_by, NEW.transcribed_at,
      NEW.reanchor_by, NEW.reanchor_at, NEW.reanchor_reason, NEW.corrected_part_way_through,
      NEW.earlier_doses_due_on, NEW.earlier_doses_due_reason, NEW.cd_schedule,
      NEW.reconciliation_id, NEW.import_batch_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.person_id, OLD.medicine_id, OLD.version, OLD.replaces_id,
      OLD.origin, OLD.vmp_id, OLD.amp_id, OLD.product_name, OLD.route_code, OLD.route_name,
      OLD.directions, OLD.pattern_kind, OLD.interval_days, OLD.weekdays, OLD.interval_weeks,
      OLD.anchor_on, OLD.day_of_month, OLD.prn_dose, OLD.indication, OLD.special_instructions,
      OLD.prescriber, OLD.starts_at, OLD.stops_at, OLD.review_on, OLD.source_kind,
      OLD.source_reference, OLD.source_document_id, OLD.transcribed_by, OLD.transcribed_at,
      OLD.reanchor_by, OLD.reanchor_at, OLD.reanchor_reason, OLD.corrected_part_way_through,
      OLD.earlier_doses_due_on, OLD.earlier_doses_due_reason, OLD.cd_schedule,
      OLD.reconciliation_id, OLD.import_batch_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'medication: what a version says never changes; record a new version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.check_at IS NOT NULL
     AND (NEW.check_by, NEW.check_at, NEW.check_outcome, NEW.check_difference)
         IS DISTINCT FROM (OLD.check_by, OLD.check_at, OLD.check_outcome, OLD.check_difference) THEN
    RAISE EXCEPTION 'medication: the second check is recorded once' USING ERRCODE = 'check_violation';
  END IF;
  -- A replacement is set once, except that a change withdrawing a later version (rule 6b) moves
  -- it to the new, earlier replacement: allowed only when the version it pointed at is withdrawn
  -- (written first, in the same transaction), the new replacement is a version of this medicine
  -- that replaces this row, and it starts no later.
  IF OLD.replaced_by_id IS NOT NULL
     AND (NEW.replaced_by_id, NEW.replaced_from) IS DISTINCT FROM (OLD.replaced_by_id, OLD.replaced_from)
     AND NOT (NEW.replaced_by_id IS NOT NULL AND NEW.replaced_from <= OLD.replaced_from
              AND EXISTS (SELECT 1 FROM public.medication w
                           WHERE w.tenant_id = OLD.tenant_id AND w.id = OLD.replaced_by_id
                             AND w.withdrawn_at IS NOT NULL)
              AND EXISTS (SELECT 1 FROM public.medication n
                           WHERE n.tenant_id = OLD.tenant_id AND n.id = NEW.replaced_by_id
                             AND n.replaces_id = OLD.id AND n.medicine_id = OLD.medicine_id
                             AND n.withdrawn_at IS NULL)) THEN
    RAISE EXCEPTION 'medication: a replacement is recorded once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL
     AND (NEW.withdrawn_by, NEW.withdrawn_at, NEW.withdrawn_reason)
         IS DISTINCT FROM (OLD.withdrawn_by, OLD.withdrawn_at, OLD.withdrawn_reason) THEN
    RAISE EXCEPTION 'medication: a withdrawal is recorded once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.stop_at IS NOT NULL
     AND (NEW.stop_by, NEW.stop_at, NEW.stop_effective_at, NEW.stop_reason, NEW.stop_source_kind,
          NEW.stop_source_reference, NEW.stop_source_document_id)
         IS DISTINCT FROM (OLD.stop_by, OLD.stop_at, OLD.stop_effective_at, OLD.stop_reason,
          OLD.stop_source_kind, OLD.stop_source_reference, OLD.stop_source_document_id)
     AND (NEW.stop_effective_at IS NULL OR NEW.stop_effective_at >= OLD.stop_effective_at) THEN
    RAISE EXCEPTION 'medication: a recorded stop is replaced only by an earlier one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user = 'harbour_app' THEN
    RAISE EXCEPTION 'medication: entries are never removed by the application'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(app.current_user_id(), NEW.updated_by);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_write_once BEFORE UPDATE ON public.medication
  FOR EACH ROW EXECUTE FUNCTION app.medication_write_once();
--> statement-breakpoint

-- A new version follows the one it replaces: the same medicine, a later number (the next after the
-- latest; a version withdrawn before it started keeps its number, so the replaced one may be
-- earlier), the same dm+d product (a change keeps the VMP, rule 6), and it is born not yet checked
-- with nothing set later. The unique (medicine, version) key refuses a second change from the same
-- latest version, so two changes cannot both land (expected_version).
CREATE OR REPLACE FUNCTION app.medication_new_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prior public.medication;
BEGIN
  IF NEW.state <> 'not_yet_checked' OR NEW.check_at IS NOT NULL OR NEW.replaced_by_id IS NOT NULL
     OR NEW.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'medication: a new version is not yet checked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version > 1 THEN
    SELECT * INTO prior FROM public.medication
      WHERE tenant_id = NEW.tenant_id AND id = NEW.replaces_id;
    IF NOT FOUND OR prior.medicine_id <> NEW.medicine_id OR prior.version >= NEW.version
       OR NEW.version <> 1 + (SELECT max(version) FROM public.medication
         WHERE tenant_id = NEW.tenant_id AND medicine_id = NEW.medicine_id)
       OR prior.vmp_id <> NEW.vmp_id OR prior.person_id <> NEW.person_id THEN
      RAISE EXCEPTION 'medication: a version follows the one before it, for the same product'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_new_version BEFORE INSERT ON public.medication
  FOR EACH ROW EXECUTE FUNCTION app.medication_new_version();
--> statement-breakpoint

-- A schedule's times are written with their entry, in the same transaction, never added later.
CREATE OR REPLACE FUNCTION app.medication_schedule_with_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.medication m
      WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.medication_id
        AND m.directions = 'regular' AND m.created_at = now()) THEN
    RAISE EXCEPTION 'medication_schedule: times are written with their regular entry'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_schedule_with_entry BEFORE INSERT ON public.medication_schedule
  FOR EACH ROW EXECUTE FUNCTION app.medication_schedule_with_entry();
--> statement-breakpoint

-- A completed reconciliation is the record of what was decided: nothing about it changes, and it
-- takes no more sources, lines or decisions (rules 7 to 12, HZ-121).
CREATE OR REPLACE FUNCTION app.medication_reconciliation_closed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    -- Retention (not the application) may still mark it deleted; nothing else changes.
    IF current_user <> 'harbour_app' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
       AND to_jsonb(NEW) - 'deleted_at' = to_jsonb(OLD) - 'deleted_at' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'medication_reconciliation: a completed reconciliation never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.person_id, NEW.trigger, NEW.placement_id, NEW.hospital_transfer_id, NEW.triggered_at,
      NEW.started_by, NEW.started_at)
     IS DISTINCT FROM (OLD.person_id, OLD.trigger, OLD.placement_id, OLD.hospital_transfer_id,
      OLD.triggered_at, OLD.started_by, OLD.started_at) THEN
    RAISE EXCEPTION 'medication_reconciliation: what it answers and who began it never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user = 'harbour_app' THEN
    RAISE EXCEPTION 'medication_reconciliation: never removed by the application'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_reconciliation_closed BEFORE UPDATE ON public.medication_reconciliation
  FOR EACH ROW EXECUTE FUNCTION app.medication_reconciliation_closed();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.medication_reconciliation_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Retention (not the application) may mark a completed reconciliation's decision deleted.
  IF TG_OP = 'UPDATE' AND current_user <> 'harbour_app'
     AND to_jsonb(OLD) ->> 'deleted_at' IS NULL AND to_jsonb(NEW) ->> 'deleted_at' IS NOT NULL
     AND to_jsonb(NEW) - 'deleted_at' = to_jsonb(OLD) - 'deleted_at' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.medication_reconciliation r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.reconciliation_id AND r.status = 'open') THEN
    RAISE EXCEPTION '%: the reconciliation is completed', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Only decisions are updated (sources and lines are append-only).
    IF (NEW.reconciliation_id, NEW.entry_id, NEW.item_id, NEW.person_id)
       IS DISTINCT FROM (OLD.reconciliation_id, OLD.entry_id, OLD.item_id, OLD.person_id) THEN
      RAISE EXCEPTION '%: what a decision is about never changes', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_reconciliation_source_open BEFORE INSERT
  ON public.medication_reconciliation_source
  FOR EACH ROW EXECUTE FUNCTION app.medication_reconciliation_open();
--> statement-breakpoint
CREATE TRIGGER medication_reconciliation_item_open BEFORE INSERT
  ON public.medication_reconciliation_item
  FOR EACH ROW EXECUTE FUNCTION app.medication_reconciliation_open();
--> statement-breakpoint
CREATE TRIGGER medication_reconciliation_decision_open BEFORE INSERT OR UPDATE
  ON public.medication_reconciliation_decision
  FOR EACH ROW EXECUTE FUNCTION app.medication_reconciliation_open();
--> statement-breakpoint

-- Versions and history: a reconciliation and its decisions are mutable aggregates while open.
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.medication_reconciliation
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.medication_reconciliation
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.medication_reconciliation_decision
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.medication_reconciliation_decision
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
-- An entry version keeps its number when its check, stop or replacement is set: each such update
-- keeps the row as it was in record_version (the history view).
CREATE TRIGGER capture_version AFTER UPDATE ON public.medication
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

-- The schedule's times, the sources and their lines are append-only (Reg 17).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medication_schedule', 'medication_reconciliation_source',
      'medication_reconciliation_item'] LOOP
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

-- No DELETE for the application anywhere: a version is stopped, replaced or withdrawn; a decision
-- is replaced by marking it deleted while the reconciliation is open.
GRANT SELECT, INSERT, UPDATE ON public.medication, public.medication_reconciliation,
  public.medication_reconciliation_decision TO harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.medication_schedule, public.medication_reconciliation_source,
  public.medication_reconciliation_item TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.medication, public.medication_schedule,
  public.medication_reconciliation, public.medication_reconciliation_source,
  public.medication_reconciliation_item, public.medication_reconciliation_decision FROM harbour_app;
--> statement-breakpoint
-- The medicines record is not published to devices yet: the offline eMAR (slices 68 to 70) adds it.

-- Sample data mode (migration 0069, HZ-072): a sample person's medicines go with them. The one
-- list is redefined with the new tables before their parents (placement, hospital_transfer,
-- document), keeping every table migration 0075 listed.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
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
GRANT SELECT, DELETE ON public.medication, public.medication_schedule,
  public.medication_reconciliation, public.medication_reconciliation_source,
  public.medication_reconciliation_item, public.medication_reconciliation_decision
  TO harbour_sample_owner;
