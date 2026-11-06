CREATE TABLE "controlled_drug_entry" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"movement" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"balance_after" numeric(12, 3) NOT NULL,
	"corrects_id" uuid,
	"corrects" text,
	"reason" text,
	"counterparty" text,
	"reference" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"witness_id" uuid,
	"witness_assertion_id" uuid,
	"no_witness_reason" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"administration_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "controlled_drug_entry_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "controlled_drug_entry_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "controlled_drug_entry_page_id_key" UNIQUE("tenant_id","page_id","id"),
	CONSTRAINT "controlled_drug_entry_seq_key" UNIQUE("tenant_id","page_id","seq"),
	CONSTRAINT "controlled_drug_entry_assertion_key" UNIQUE("tenant_id","witness_assertion_id"),
	CONSTRAINT "controlled_drug_entry_movement" CHECK (movement IN ('receipt', 'administration', 'disposal', 'transfer_out', 'destruction', 'correction')),
	CONSTRAINT "controlled_drug_entry_seq" CHECK (seq >= 1),
	CONSTRAINT "controlled_drug_entry_balance" CHECK (balance_after >= 0),
	CONSTRAINT "controlled_drug_entry_quantity" CHECK ((movement <> 'correction' AND quantity > 0)
       OR (movement = 'correction' AND corrects = 'quantity' AND quantity <> 0)
       OR (movement = 'correction' AND corrects = 'detail' AND quantity = 0)),
	CONSTRAINT "controlled_drug_entry_correction" CHECK ((movement = 'correction' AND corrects_id IS NOT NULL AND corrects IN ('quantity', 'detail')
           AND length(btrim(coalesce(reason, ''))) > 0)
       OR (movement <> 'correction' AND corrects_id IS NULL AND corrects IS NULL)),
	CONSTRAINT "controlled_drug_entry_witness" CHECK ((witness_id IS NOT NULL AND witness_assertion_id IS NOT NULL AND no_witness_reason IS NULL
           AND witness_id <> recorded_by)
       OR (witness_id IS NULL AND witness_assertion_id IS NULL
           AND length(btrim(coalesce(no_witness_reason, ''))) > 0 AND movement <> 'destruction')),
	CONSTRAINT "controlled_drug_entry_administration" CHECK (administration_id IS NULL OR movement IN ('administration', 'correction')),
	CONSTRAINT "controlled_drug_entry_flags" CHECK (flags <@ ARRAY['no_witness_for_review']::text[])
);
--> statement-breakpoint
CREATE TABLE "controlled_drug_page" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"vmp_id" text NOT NULL,
	"product_name" text NOT NULL,
	"unit_code" text NOT NULL,
	"unit_name" text NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "controlled_drug_page_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "controlled_drug_page_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "controlled_drug_page_person_vmp_key" UNIQUE("tenant_id","person_id","vmp_id"),
	CONSTRAINT "controlled_drug_page_vmp" CHECK (vmp_id ~ '^[0-9]{6,18}$'),
	CONSTRAINT "controlled_drug_page_names" CHECK (length(btrim(product_name)) > 0 AND length(btrim(unit_code)) > 0 AND length(btrim(unit_name)) > 0)
);
--> statement-breakpoint
CREATE TABLE "controlled_drug_stock_check" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"counted" numeric(12, 3) NOT NULL,
	"expected" numeric(12, 3) NOT NULL,
	"difference" numeric(12, 3) NOT NULL,
	"reason" text,
	"checked_by" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"witness_id" uuid,
	"witness_assertion_id" uuid,
	"no_witness_reason" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "controlled_drug_stock_check_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "controlled_drug_stock_check_assertion_key" UNIQUE("tenant_id","witness_assertion_id"),
	CONSTRAINT "controlled_drug_stock_check_flags" CHECK (flags <@ ARRAY['no_witness_for_review']::text[]),
	CONSTRAINT "controlled_drug_stock_check_counted" CHECK (counted >= 0 AND expected >= 0),
	CONSTRAINT "controlled_drug_stock_check_difference" CHECK (difference = counted - expected),
	CONSTRAINT "controlled_drug_stock_check_reason" CHECK (difference = 0 OR length(btrim(coalesce(reason, ''))) > 0),
	CONSTRAINT "controlled_drug_stock_check_witness" CHECK ((witness_id IS NOT NULL AND witness_assertion_id IS NOT NULL AND no_witness_reason IS NULL
           AND witness_id <> checked_by)
       OR (witness_id IS NULL AND witness_assertion_id IS NULL
           AND length(btrim(coalesce(no_witness_reason, ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "controlled_drug_witness_assertion" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"movement" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"administration_id" uuid,
	"witness_id" uuid NOT NULL,
	"recorder_id" uuid NOT NULL,
	"asserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "controlled_drug_witness_assertion_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "controlled_drug_witness_assertion_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "controlled_drug_witness_assertion_two_people" CHECK (witness_id <> recorder_id),
	CONSTRAINT "controlled_drug_witness_assertion_movement" CHECK (movement IN ('receipt', 'administration', 'disposal', 'transfer_out', 'destruction', 'correction', 'stock_check')),
	CONSTRAINT "controlled_drug_witness_assertion_expiry" CHECK (expires_at > asserted_at)
);
--> statement-breakpoint
ALTER TABLE "medication_administration" DROP CONSTRAINT "medication_administration_flags";--> statement-breakpoint
ALTER TABLE "controlled_drug_entry" ADD CONSTRAINT "controlled_drug_entry_page_fk" FOREIGN KEY ("tenant_id","person_id","page_id") REFERENCES "public"."controlled_drug_page"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_entry" ADD CONSTRAINT "controlled_drug_entry_corrects_fk" FOREIGN KEY ("tenant_id","page_id","corrects_id") REFERENCES "public"."controlled_drug_entry"("tenant_id","page_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_entry" ADD CONSTRAINT "controlled_drug_entry_assertion_fk" FOREIGN KEY ("tenant_id","person_id","witness_assertion_id") REFERENCES "public"."controlled_drug_witness_assertion"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_entry" ADD CONSTRAINT "controlled_drug_entry_administration_fk" FOREIGN KEY ("tenant_id","person_id","administration_id") REFERENCES "public"."medication_administration"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_entry" ADD CONSTRAINT "controlled_drug_entry_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_entry" ADD CONSTRAINT "controlled_drug_entry_witness_fk" FOREIGN KEY ("tenant_id","witness_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_page" ADD CONSTRAINT "controlled_drug_page_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_page" ADD CONSTRAINT "controlled_drug_page_opened_by_fk" FOREIGN KEY ("tenant_id","opened_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_stock_check" ADD CONSTRAINT "controlled_drug_stock_check_page_fk" FOREIGN KEY ("tenant_id","person_id","page_id") REFERENCES "public"."controlled_drug_page"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_stock_check" ADD CONSTRAINT "controlled_drug_stock_check_assertion_fk" FOREIGN KEY ("tenant_id","person_id","witness_assertion_id") REFERENCES "public"."controlled_drug_witness_assertion"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_stock_check" ADD CONSTRAINT "controlled_drug_stock_check_checked_by_fk" FOREIGN KEY ("tenant_id","checked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_stock_check" ADD CONSTRAINT "controlled_drug_stock_check_witness_fk" FOREIGN KEY ("tenant_id","witness_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD CONSTRAINT "controlled_drug_witness_assertion_page_fk" FOREIGN KEY ("tenant_id","person_id","page_id") REFERENCES "public"."controlled_drug_page"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD CONSTRAINT "controlled_drug_witness_assertion_witness_fk" FOREIGN KEY ("tenant_id","witness_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD CONSTRAINT "controlled_drug_witness_assertion_recorder_fk" FOREIGN KEY ("tenant_id","recorder_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "controlled_drug_entry_administration_key" ON "controlled_drug_entry" USING btree ("tenant_id","administration_id") WHERE administration_id IS NOT NULL AND movement = 'administration';--> statement-breakpoint
CREATE INDEX "controlled_drug_stock_check_page_idx" ON "controlled_drug_stock_check" USING btree ("tenant_id","page_id","checked_at");--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_flags" CHECK (flags <@ ARRAY['early', 'late', 'interval_override', 'competence_override',
        'amount_differs', 'entry_not_yet_checked', 'other_unit_not_counted', 'over_maximum',
        'before_window', 'earlier_dose_outstanding', 'entry_not_usable', 'no_usable_dosing_record',
        'amount_in_other_unit', 'competence_not_current', 'given_before_recorded',
        'given_by_someone_else', 'close_to_last_dose', 'clock_drift', 'corrected',
        'dose_removed', 'dose_moved', 'breach_created', 'breach_hidden', 'close_to_next_dose',
        'inside_minimum_interval']::text[]);
--> statement-breakpoint
-- Controlled drugs register security (ADR-0002 patterns; ADR-0083; medicines.md section 14;
-- slice 34). Runs as harbour_owner. Every row is about one person and follows that person's scope.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['controlled_drug_page', 'controlled_drug_entry',
      'controlled_drug_witness_assertion', 'controlled_drug_stock_check'] LOOP
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

-- A witness's assertion (ADR-0084): stamped by the server, and afterwards it changes only by being
-- used, once, by the entry or stock check that matches it.
CREATE OR REPLACE FUNCTION app.controlled_drug_witness_assertion_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.asserted_at := now();
    NEW.used_at := NULL;
    IF NEW.expires_at <= now() OR NEW.expires_at > now() + interval '1 day' THEN
      RAISE EXCEPTION 'controlled_drug_witness_assertion: it expires soon after it is made'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) - 'used_at' IS DISTINCT FROM to_jsonb(OLD) - 'used_at'
     OR OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'controlled_drug_witness_assertion: it is used once and never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER controlled_drug_witness_assertion_guard
  BEFORE INSERT OR UPDATE ON public.controlled_drug_witness_assertion
  FOR EACH ROW EXECUTE FUNCTION app.controlled_drug_witness_assertion_guard();
--> statement-breakpoint

-- Uses a witness assertion for an entry or a stock check: the same page, witness, movement,
-- quantity and administration, by the recorder the witness named, unused and not expired
-- (ADR-0084; slice 34 security review M2).
CREATE OR REPLACE FUNCTION app.controlled_drug_use_assertion(
  p_tenant uuid, p_assertion uuid, p_page uuid, p_witness uuid, p_movement text,
  p_quantity numeric, p_administration uuid, p_recorder uuid
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.controlled_drug_witness_assertion a SET used_at = now()
   WHERE a.tenant_id = p_tenant AND a.id = p_assertion AND a.page_id = p_page
     AND a.witness_id = p_witness AND a.movement = p_movement AND a.quantity = p_quantity
     AND a.administration_id IS NOT DISTINCT FROM p_administration
     AND a.recorder_id = p_recorder
     AND a.used_at IS NULL AND a.expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'controlled_drug: the witness did not sign for this, or the signature has expired or been used'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint

-- The running balance (rule 25), checked by the database on every entry: the next place on the
-- page, never earlier than the entry before, the balance after it following from that entry's,
-- the witness's assertion used, and an administration's entry naming that administration both
-- ways (slice 22's hook). Concurrent entries on one page meet the unique (page, seq) key.
CREATE OR REPLACE FUNCTION app.controlled_drug_entry_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev public.controlled_drug_entry;
DECLARE expected numeric;
BEGIN
  NEW.recorded_at := now();
  SELECT * INTO prev FROM public.controlled_drug_entry e
   WHERE e.tenant_id = NEW.tenant_id AND e.page_id = NEW.page_id
   ORDER BY e.seq DESC LIMIT 1;
  IF NEW.seq <> COALESCE(prev.seq, 0) + 1 THEN
    RAISE EXCEPTION 'controlled_drug_entry: entries follow one another on the page'
      USING ERRCODE = 'check_violation';
  END IF;
  IF prev.id IS NOT NULL AND NEW.occurred_at < prev.occurred_at THEN
    RAISE EXCEPTION 'controlled_drug_entry: entries go in time order; record a correction'
      USING ERRCODE = 'check_violation';
  END IF;
  expected := COALESCE(prev.balance_after, 0)
    + CASE WHEN NEW.movement IN ('receipt', 'correction') THEN NEW.quantity ELSE -NEW.quantity END;
  IF NEW.balance_after <> expected THEN
    RAISE EXCEPTION 'controlled_drug_entry: the balance after it does not follow from the page'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.witness_assertion_id IS NOT NULL THEN
    PERFORM app.controlled_drug_use_assertion(NEW.tenant_id, NEW.witness_assertion_id,
      NEW.page_id, NEW.witness_id, NEW.movement, NEW.quantity, NEW.administration_id,
      NEW.recorded_by);
  END IF;
  -- The witness to a dose is never the member who gave it (slice 34 security review H2).
  IF NEW.administration_id IS NOT NULL AND NEW.witness_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.medication_administration a
       WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.administration_id
         AND NEW.witness_id IN (a.recorded_by, a.administered_by)) THEN
    RAISE EXCEPTION 'controlled_drug_entry: the witness did not give or record the dose'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.administration_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.medication_administration a
       WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.administration_id
         AND a.cd_entry_id = NEW.id) THEN
    RAISE EXCEPTION 'controlled_drug_entry: an administration and its entry name each other'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER controlled_drug_entry_insert BEFORE INSERT ON public.controlled_drug_entry
  FOR EACH ROW EXECUTE FUNCTION app.controlled_drug_entry_insert();
--> statement-breakpoint

-- A stock check counts against the page as it stands (rule 24) and uses its witness's assertion.
CREATE OR REPLACE FUNCTION app.controlled_drug_stock_check_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.checked_at := now();
  IF NEW.expected <> COALESCE((SELECT e.balance_after FROM public.controlled_drug_entry e
      WHERE e.tenant_id = NEW.tenant_id AND e.page_id = NEW.page_id
      ORDER BY e.seq DESC LIMIT 1), 0) THEN
    RAISE EXCEPTION 'controlled_drug_stock_check: the balance expected is the page''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.witness_assertion_id IS NOT NULL THEN
    PERFORM app.controlled_drug_use_assertion(NEW.tenant_id, NEW.witness_assertion_id,
      NEW.page_id, NEW.witness_id, 'stock_check', NEW.counted, NULL, NEW.checked_by);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER controlled_drug_stock_check_insert BEFORE INSERT ON public.controlled_drug_stock_check
  FOR EACH ROW EXECUTE FUNCTION app.controlled_drug_stock_check_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.controlled_drug_page_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.opened_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER controlled_drug_page_insert BEFORE INSERT ON public.controlled_drug_page
  FOR EACH ROW EXECUTE FUNCTION app.controlled_drug_page_insert();
--> statement-breakpoint

-- Pages, entries and stock checks are never edited (ADR-0083; section 5.5).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['controlled_drug_page', 'controlled_drug_entry',
      'controlled_drug_stock_check'] LOOP
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

GRANT SELECT, INSERT ON public.controlled_drug_page, public.controlled_drug_entry,
  public.controlled_drug_stock_check TO harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.controlled_drug_witness_assertion TO harbour_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.controlled_drug_page, public.controlled_drug_entry,
  public.controlled_drug_stock_check FROM harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.controlled_drug_witness_assertion FROM harbour_app;
--> statement-breakpoint

-- Sample data mode (migration 0069, HZ-072): a sample person's register goes with them, before
-- the administrations its entries name. Every table migration 0123 listed is kept.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'controlled_drug_stock_check', 'controlled_drug_entry', 'controlled_drug_witness_assertion',
    'controlled_drug_page',
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
GRANT SELECT, DELETE ON public.controlled_drug_page, public.controlled_drug_entry,
  public.controlled_drug_witness_assertion, public.controlled_drug_stock_check
  TO harbour_sample_owner;
