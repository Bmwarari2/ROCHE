-- Back-entry from paper during an outage (slice 11 part 2; operations.md rules 11 to 15; HZ-017):
-- expand-only columns on the five entries a device or the web writes (empty on every existing
-- entry), the outage's (tenant_id, id) key they reference, and, below, the guards. Runs as
-- harbour_owner.
ALTER TABLE "activity_record" ADD COLUMN "late_entry_reason" text;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "outage_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "paper_date" date;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "paper_time" time;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "paper_occurrence" text;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "outside_outage_reason" text;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "paper_reference" text;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "not_from_paper_reason" text;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "late_entry_reason" text;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "outage_id" uuid;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "paper_date" date;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "paper_time" time;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "paper_occurrence" text;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "outside_outage_reason" text;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "paper_reference" text;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "not_from_paper_reason" text;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "late_entry_reason" text;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "outage_id" uuid;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "paper_date" date;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "paper_time" time;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "paper_occurrence" text;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "outside_outage_reason" text;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "paper_reference" text;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "not_from_paper_reason" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "late_entry_reason" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "outage_id" uuid;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "paper_date" date;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "paper_time" time;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "paper_occurrence" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "outside_outage_reason" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "paper_reference" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "not_from_paper_reason" text;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "late_entry_reason" text;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "outage_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "paper_date" date;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "paper_time" time;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "paper_occurrence" text;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "outside_outage_reason" text;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "paper_reference" text;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "not_from_paper_reason" text;--> statement-breakpoint
ALTER TABLE "outage" ADD CONSTRAINT "outage_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_outage_fk" FOREIGN KEY ("tenant_id","outage_id") REFERENCES "public"."outage"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_outage_fk" FOREIGN KEY ("tenant_id","outage_id") REFERENCES "public"."outage"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_note" ADD CONSTRAINT "care_note_outage_fk" FOREIGN KEY ("tenant_id","outage_id") REFERENCES "public"."outage"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_outage_fk" FOREIGN KEY ("tenant_id","outage_id") REFERENCES "public"."outage"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_outage_fk" FOREIGN KEY ("tenant_id","outage_id") REFERENCES "public"."outage"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_record_outage_idx" ON "activity_record" USING btree ("tenant_id","outage_id") WHERE outage_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "body_map_mark_outage_idx" ON "body_map_mark" USING btree ("tenant_id","outage_id") WHERE outage_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "care_note_outage_idx" ON "care_note" USING btree ("tenant_id","outage_id") WHERE outage_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "observation_outage_idx" ON "observation" USING btree ("tenant_id","outage_id") WHERE outage_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "visit_log_outage_idx" ON "visit_log" USING btree ("tenant_id","outage_id") WHERE outage_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_back_entry" CHECK (CASE WHEN late_entry_reason = 'downtime'
  THEN outage_id IS NOT NULL AND paper_date IS NOT NULL AND paper_time IS NOT NULL
    AND extract(second FROM paper_time) = 0 AND paper_occurrence IN ('only', 'earlier', 'later')
    AND not_from_paper_reason IS NULL
    AND (outside_outage_reason IS NULL OR btrim(outside_outage_reason) <> '')
  ELSE late_entry_reason IS NULL AND paper_date IS NULL AND paper_time IS NULL
    AND paper_occurrence IS NULL AND outside_outage_reason IS NULL AND paper_reference IS NULL
    AND (outage_id IS NULL) = (not_from_paper_reason IS NULL)
    AND (not_from_paper_reason IS NULL OR btrim(not_from_paper_reason) <> '')
END);--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_back_entry" CHECK (CASE WHEN late_entry_reason = 'downtime'
  THEN outage_id IS NOT NULL AND paper_date IS NOT NULL AND paper_time IS NOT NULL
    AND extract(second FROM paper_time) = 0 AND paper_occurrence IN ('only', 'earlier', 'later')
    AND not_from_paper_reason IS NULL
    AND (outside_outage_reason IS NULL OR btrim(outside_outage_reason) <> '')
  ELSE late_entry_reason IS NULL AND paper_date IS NULL AND paper_time IS NULL
    AND paper_occurrence IS NULL AND outside_outage_reason IS NULL AND paper_reference IS NULL
    AND (outage_id IS NULL) = (not_from_paper_reason IS NULL)
    AND (not_from_paper_reason IS NULL OR btrim(not_from_paper_reason) <> '')
END);--> statement-breakpoint
ALTER TABLE "care_note" ADD CONSTRAINT "care_note_back_entry" CHECK (CASE WHEN late_entry_reason = 'downtime'
  THEN outage_id IS NOT NULL AND paper_date IS NOT NULL AND paper_time IS NOT NULL
    AND extract(second FROM paper_time) = 0 AND paper_occurrence IN ('only', 'earlier', 'later')
    AND not_from_paper_reason IS NULL
    AND (outside_outage_reason IS NULL OR btrim(outside_outage_reason) <> '')
  ELSE late_entry_reason IS NULL AND paper_date IS NULL AND paper_time IS NULL
    AND paper_occurrence IS NULL AND outside_outage_reason IS NULL AND paper_reference IS NULL
    AND (outage_id IS NULL) = (not_from_paper_reason IS NULL)
    AND (not_from_paper_reason IS NULL OR btrim(not_from_paper_reason) <> '')
END);--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_back_entry" CHECK (CASE WHEN late_entry_reason = 'downtime'
  THEN outage_id IS NOT NULL AND paper_date IS NOT NULL AND paper_time IS NOT NULL
    AND extract(second FROM paper_time) = 0 AND paper_occurrence IN ('only', 'earlier', 'later')
    AND not_from_paper_reason IS NULL
    AND (outside_outage_reason IS NULL OR btrim(outside_outage_reason) <> '')
  ELSE late_entry_reason IS NULL AND paper_date IS NULL AND paper_time IS NULL
    AND paper_occurrence IS NULL AND outside_outage_reason IS NULL AND paper_reference IS NULL
    AND (outage_id IS NULL) = (not_from_paper_reason IS NULL)
    AND (not_from_paper_reason IS NULL OR btrim(not_from_paper_reason) <> '')
END);--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_back_entry" CHECK (CASE WHEN late_entry_reason = 'downtime'
  THEN outage_id IS NOT NULL AND paper_date IS NOT NULL AND paper_time IS NOT NULL
    AND extract(second FROM paper_time) = 0 AND paper_occurrence IN ('only', 'earlier', 'later')
    AND not_from_paper_reason IS NULL
    AND (outside_outage_reason IS NULL OR btrim(outside_outage_reason) <> '')
  ELSE late_entry_reason IS NULL AND paper_date IS NULL AND paper_time IS NULL
    AND paper_occurrence IS NULL AND outside_outage_reason IS NULL AND paper_reference IS NULL
    AND (outage_id IS NULL) = (not_from_paper_reason IS NULL)
    AND (not_from_paper_reason IS NULL OR btrim(not_from_paper_reason) <> '')
END);--> statement-breakpoint

-- An entry that names an outage (a back-entry, or one written later that was not from paper) names
-- one at its own location that was not cancelled (operations.md rule 12). The lookup runs under the
-- writer's row-level security, so an outage they cannot see is refused too.
CREATE OR REPLACE FUNCTION app.entry_outage_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_outage record;
BEGIN
  IF NEW.outage_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT o.location_id, o.state INTO v_outage FROM public.outage o
    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.outage_id;
  IF NOT FOUND OR v_outage.location_id <> NEW.location_id OR v_outage.state = 'cancelled' THEN
    RAISE EXCEPTION 'An entry names an outage at its own location that was not cancelled'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['care_note', 'observation', 'body_map_mark', 'activity_record',
    'visit_log'] LOOP
    EXECUTE format(
      'CREATE TRIGGER entry_outage_guard BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.entry_outage_guard()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- The outage guard of 0051 (with #32 review round 1), plus rules 14 and 15: an outage is not
-- cancelled once a back-entry cites it, and is reconciled only by someone who entered none of its
-- back-entries. Both look in the organisation's view and restore the caller's before going on (as
-- app.admit_handed_over_entry does; an error rolls the setting back with its statement), so a
-- back-entry about someone the caller can no longer see still counts; tenant isolation still
-- applies. A trigger function cannot be called on its own, so the wider view reaches nothing else.
CREATE OR REPLACE FUNCTION app.outage_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_closing boolean := OLD.state = 'declared' AND NEW.state = 'closed';
  v_scope text;
  v_found boolean;
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.declared_at IS DISTINCT FROM OLD.declared_at
     OR NEW.declared_by IS DISTINCT FROM OLD.declared_by
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'An outage keeps its location and declaration, and is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('reconciled', 'cancelled') THEN
    RAISE EXCEPTION 'A % outage is final', OLD.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF (OLD.state, NEW.state) NOT IN (
         ('declared', 'closed'), ('closed', 'reconciled'), ('declared', 'cancelled')) THEN
      RAISE EXCEPTION 'An outage cannot move from % to %', OLD.state, NEW.state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF app.current_user_id() IS NOT NULL AND app.current_user_id() IS DISTINCT FROM
         (CASE NEW.state WHEN 'closed' THEN NEW.closed_by WHEN 'reconciled' THEN NEW.reconciled_by
           ELSE NEW.cancelled_by END) THEN
      RAISE EXCEPTION 'An outage is closed, reconciled or cancelled in the name of the member doing it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.state IN ('cancelled', 'reconciled') THEN
      v_scope := coalesce(current_setting('app.scope', true), '');
      PERFORM set_config('app.scope', 'tenant', true);
      SELECT EXISTS (
        SELECT 1 FROM (
          SELECT created_by FROM public.care_note
            WHERE tenant_id = OLD.tenant_id AND outage_id = OLD.id AND late_entry_reason = 'downtime'
          UNION ALL
          SELECT created_by FROM public.observation
            WHERE tenant_id = OLD.tenant_id AND outage_id = OLD.id AND late_entry_reason = 'downtime'
          UNION ALL
          SELECT created_by FROM public.body_map_mark
            WHERE tenant_id = OLD.tenant_id AND outage_id = OLD.id AND late_entry_reason = 'downtime'
          UNION ALL
          SELECT created_by FROM public.activity_record
            WHERE tenant_id = OLD.tenant_id AND outage_id = OLD.id AND late_entry_reason = 'downtime'
          UNION ALL
          SELECT created_by FROM public.visit_log
            WHERE tenant_id = OLD.tenant_id AND outage_id = OLD.id AND late_entry_reason = 'downtime'
        ) e
        WHERE NEW.state = 'cancelled' OR e.created_by IS NOT DISTINCT FROM NEW.reconciled_by)
        INTO v_found;
      PERFORM set_config('app.scope', v_scope, true);
      IF v_found THEN
        RAISE EXCEPTION '%', CASE NEW.state
            WHEN 'cancelled' THEN 'An outage cannot be cancelled once a paper record entered against it cites it'
            ELSE 'Someone who entered none of the outage''s paper records confirms it reconciled' END
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  IF (NEW.closed_at, NEW.closed_by, NEW.back_entry_due_at)
       IS DISTINCT FROM (OLD.closed_at, OLD.closed_by, OLD.back_entry_due_at)
     AND NOT v_closing THEN
    RAISE EXCEPTION 'An outage''s closure is set once, when it closes'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_closing THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason THEN
      RAISE EXCEPTION 'Close an outage and correct its start separately'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF (NEW.started_at, NEW.ended_at) IS DISTINCT FROM (OLD.started_at, OLD.ended_at) THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR (OLD.ended_at IS NULL) <> (NEW.ended_at IS NULL)
       OR coalesce(btrim(NEW.correction_reason), '') = ''
       OR NEW.correction_reason IS NOT DISTINCT FROM OLD.correction_reason THEN
      RAISE EXCEPTION 'An outage''s start or end is corrected only with a reason of its own, before it is reconciled, and an open outage stays open'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.correction_reason IS DISTINCT FROM OLD.correction_reason THEN
    RAISE EXCEPTION 'A correction reason goes with a corrected start or end'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.declared_late := CASE WHEN NEW.started_at IS DISTINCT FROM OLD.started_at
    THEN app.outage_declared_late(NEW.location_id, NEW.started_at, NEW.declared_at)
    ELSE OLD.declared_late END;
  RETURN NEW;
END
$$;
