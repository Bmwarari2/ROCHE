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

-- The time a paper form gives, in UK time (#38 review round 1, clinical M1; mirrors the domain's
-- `resolvePaperTime`): the date and time as written, read as British Summer Time (`earlier`) and as
-- Greenwich Mean Time (`later`), keeping each reading that is that time in Europe/London. Both in
-- the hour the clocks go back: the occurrence chosen picks one, and `only` is refused. One: only
-- `only` is accepted. None (the hour the clocks go forward): refused. Null when refused.
CREATE OR REPLACE FUNCTION app.paper_instant(p_date date, p_time time, p_occurrence text)
RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  WITH readings AS (
    SELECT r.instant, r.which
    FROM (VALUES
      (((p_date + p_time) AT TIME ZONE 'UTC') - interval '1 hour', 'earlier'),
      (((p_date + p_time) AT TIME ZONE 'UTC'), 'later')) AS r(instant, which)
    WHERE (r.instant AT TIME ZONE 'Europe/London') = (p_date + p_time)
  )
  SELECT CASE (SELECT count(*) FROM readings)
    WHEN 2 THEN (SELECT instant FROM readings WHERE which = p_occurrence)
    WHEN 1 THEN (SELECT instant FROM readings WHERE p_occurrence = 'only')
  END
$$;
--> statement-breakpoint

-- A rate-table figure in force for a location's nation on the UK date of an instant, the
-- organisation's own first (as resolveRate chooses); null when there is none.
CREATE OR REPLACE FUNCTION app.location_rate(p_location_id uuid, p_key text, p_on timestamptz)
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT r.value FROM public.rate_table r, public.location l
  WHERE l.id = p_location_id AND r.key = p_key AND r.nation IN (l.nation::text, 'uk', 'all')
    AND r.valid_from <= (p_on AT TIME ZONE 'Europe/London')::date
    AND (r.valid_to IS NULL OR r.valid_to > (p_on AT TIME ZONE 'Europe/London')::date)
    AND (r.tenant_id IS NULL OR r.tenant_id = app.current_tenant_id())
  ORDER BY r.tenant_id IS NOT NULL DESC,
    CASE r.nation WHEN l.nation::text THEN 3 WHEN 'uk' THEN 2 ELSE 1 END DESC
  LIMIT 1
$$;
--> statement-breakpoint

-- An entry that names an outage (operations.md rules 11 to 13; #38 review round 1):
-- - a correction of a back-entry stays a back-entry of the same outage: its paper details are
--   carried from the entry it corrects when it gives none, and refused when it names another;
-- - the writer must be able to see the outage, at the entry's own location, neither cancelled nor
--   reconciled; it is read again locked for share, in the system's view (a share lock needs the
--   update policy), so a cancel or a reconciliation running at the same time waits for this entry
--   and then counts it;
-- - a back-entry's time is the instant its paper date, time and occurrence give;
-- - a back-entry outside the outage window [start, end) says why; an open outage runs to now plus
--   `sync.clock_drift_flag_minutes`; an entry not from paper names only an outage it falls in.
CREATE OR REPLACE FUNCTION app.entry_outage_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_original record;
  v_outage record;
  v_scope text;
  v_user text;
  v_seen boolean;  -- seen, at the entry's location, and still open to entries
  v_end timestamptz;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    EXECUTE format(
      'SELECT late_entry_reason, outage_id, paper_date, paper_time, paper_occurrence, '
      'paper_reference, outside_outage_reason FROM public.%I WHERE id = $1', TG_TABLE_NAME)
      INTO v_original USING NEW.supersedes_id;
    IF v_original.late_entry_reason = 'downtime' THEN
      IF num_nonnulls(NEW.late_entry_reason, NEW.outage_id, NEW.paper_date, NEW.paper_time,
           NEW.paper_occurrence, NEW.paper_reference, NEW.outside_outage_reason,
           NEW.not_from_paper_reason) = 0 THEN
        NEW.late_entry_reason := 'downtime';
        NEW.outage_id := v_original.outage_id;
        NEW.paper_date := v_original.paper_date;
        NEW.paper_time := v_original.paper_time;
        NEW.paper_occurrence := v_original.paper_occurrence;
        NEW.paper_reference := v_original.paper_reference;
        NEW.outside_outage_reason := v_original.outside_outage_reason;
      ELSIF NEW.late_entry_reason IS DISTINCT FROM 'downtime'
         OR NEW.outage_id IS DISTINCT FROM v_original.outage_id THEN
        RAISE EXCEPTION 'A correction of a paper record stays a paper record of the same outage'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  IF NEW.outage_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.outage o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.outage_id;
  v_seen := FOUND;
  IF v_seen THEN
    v_scope := coalesce(current_setting('app.scope', true), '');
    v_user := coalesce(current_setting('app.user_id', true), '');
    PERFORM set_config('app.scope', 'tenant', true);
    PERFORM set_config('app.user_id', '', true);
    SELECT o.location_id, o.state, o.started_at, o.ended_at INTO v_outage FROM public.outage o
      WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.outage_id FOR SHARE;
    PERFORM set_config('app.scope', v_scope, true);
    PERFORM set_config('app.user_id', v_user, true);
    v_seen := v_outage.location_id = NEW.location_id
      AND v_outage.state NOT IN ('cancelled', 'reconciled');
  END IF;
  IF NOT v_seen THEN
    RAISE EXCEPTION 'An entry names an outage at its own location that is neither cancelled nor reconciled'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- Incomplete paper details are left to the CHECK, which says what is missing.
  IF NEW.late_entry_reason = 'downtime'
     AND num_nonnulls(NEW.paper_date, NEW.paper_time, NEW.paper_occurrence) = 3
     AND app.paper_instant(NEW.paper_date, NEW.paper_time, NEW.paper_occurrence)
       IS DISTINCT FROM NEW.occurred_at THEN
    RAISE EXCEPTION 'A paper record''s time is the date and time written on it in UK time: the first or second time in the hour the clocks go back, never a time in the hour they go forward'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  v_end := coalesce(v_outage.ended_at, now() + interval '1 minute' * coalesce(
    app.location_rate(NEW.location_id, 'sync.clock_drift_flag_minutes', now()), 0));
  IF NEW.occurred_at < v_outage.started_at OR NEW.occurred_at >= v_end THEN
    IF NEW.late_entry_reason IS DISTINCT FROM 'downtime' THEN
      RAISE EXCEPTION 'An entry not written on paper names only an outage its time falls in'
        USING ERRCODE = 'integrity_constraint_violation';
    ELSIF NEW.outside_outage_reason IS NULL THEN
      RAISE EXCEPTION 'A paper record with a time outside its outage says why'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
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

-- The back-entries that cite an outage, from the five entries: who entered each and who sent it
-- for them, its event time and any reason it is outside the outage, whether it corrects another
-- entry, and whether a later entry corrects it. Invoker rights: under the caller's row-level
-- security, so it never shows more than they could read; the guard below calls it in the
-- organisation's view.
CREATE OR REPLACE FUNCTION app.outage_back_entries(p_outage_id uuid)
RETURNS TABLE (created_by uuid, handed_over_by uuid, occurred_at timestamptz,
  outside_outage_reason text, is_correction boolean, superseded boolean)
LANGUAGE sql STABLE AS $$
  SELECT t.created_by, t.handed_over_by, t.occurred_at, t.outside_outage_reason,
    t.supersedes_id IS NOT NULL, EXISTS (SELECT 1 FROM public.care_note s WHERE s.supersedes_id = t.id)
    FROM public.care_note t WHERE t.outage_id = p_outage_id AND t.late_entry_reason = 'downtime'
  UNION ALL
  SELECT t.created_by, t.handed_over_by, t.occurred_at, t.outside_outage_reason,
    t.supersedes_id IS NOT NULL, EXISTS (SELECT 1 FROM public.observation s WHERE s.supersedes_id = t.id)
    FROM public.observation t WHERE t.outage_id = p_outage_id AND t.late_entry_reason = 'downtime'
  UNION ALL
  SELECT t.created_by, t.handed_over_by, t.occurred_at, t.outside_outage_reason,
    t.supersedes_id IS NOT NULL, EXISTS (SELECT 1 FROM public.body_map_mark s WHERE s.supersedes_id = t.id)
    FROM public.body_map_mark t WHERE t.outage_id = p_outage_id AND t.late_entry_reason = 'downtime'
  UNION ALL
  SELECT t.created_by, t.handed_over_by, t.occurred_at, t.outside_outage_reason,
    t.supersedes_id IS NOT NULL, EXISTS (SELECT 1 FROM public.activity_record s WHERE s.supersedes_id = t.id)
    FROM public.activity_record t WHERE t.outage_id = p_outage_id AND t.late_entry_reason = 'downtime'
  UNION ALL
  SELECT t.created_by, t.handed_over_by, t.occurred_at, t.outside_outage_reason,
    t.supersedes_id IS NOT NULL, EXISTS (SELECT 1 FROM public.visit_log s WHERE s.supersedes_id = t.id)
    FROM public.visit_log t WHERE t.outage_id = p_outage_id AND t.late_entry_reason = 'downtime'
$$;
--> statement-breakpoint

-- The outage guard of 0051 (with #32 review round 1), plus rules 14 and 15: an outage is not
-- cancelled once a current back-entry cites it; it is reconciled only by someone who entered and
-- sent none of its original back-entries (correcting one during the review does not count); and
-- no start or end (a correction, or the end given on closing) leaves a current back-entry with no
-- reason for being outside the window [start, end) outside it (#32 review round 2; #38 review
-- round 1). These look in the organisation's view and restore the caller's before going on (as
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
        SELECT 1 FROM app.outage_back_entries(OLD.id) e
        WHERE (NEW.state = 'cancelled' AND NOT e.superseded)
           OR (NEW.state = 'reconciled' AND NOT e.is_correction
               AND NEW.reconciled_by IN (e.created_by, e.handed_over_by)))
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
  IF (NEW.started_at, NEW.ended_at) IS DISTINCT FROM (OLD.started_at, OLD.ended_at) THEN
    v_scope := coalesce(current_setting('app.scope', true), '');
    PERFORM set_config('app.scope', 'tenant', true);
    SELECT EXISTS (
      SELECT 1 FROM app.outage_back_entries(OLD.id) e
      WHERE NOT e.superseded AND e.outside_outage_reason IS NULL
        AND (e.occurred_at < NEW.started_at OR e.occurred_at >= NEW.ended_at))
      INTO v_found;
    PERFORM set_config('app.scope', v_scope, true);
    IF v_found THEN
      RAISE EXCEPTION 'This start or end would leave a paper record entered against the outage outside it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  NEW.declared_late := CASE WHEN NEW.started_at IS DISTINCT FROM OLD.started_at
    THEN app.outage_declared_late(NEW.location_id, NEW.started_at, NEW.declared_at)
    ELSE OLD.declared_late END;
  RETURN NEW;
END
$$;
