-- Phones hold a home's recent records per home and day (ADR-0134; HZ-002, HZ-138). PowerSync
-- refuses a connection over its buckets limit, and streams keyed by person and day made thousands
-- of buckets for one phone at a 60-bed home. The home streams now filter on the row's own
-- `sync_location_id`, which is routing only (an entry's `location_id` stays where it was made):
-- the person's home while they receive care (active, on leave or in hospital), and none once they
-- have left care, so a discharged, deceased or archived person's record leaves the home's phones
-- as before (sync-config.yaml, L1). The database sets it on insert and moves it, for the records
-- in the sync window, when the person's home or status changes, so a person who moves keeps the
-- last weeks of notes, charts, tasks and administrations on the new home's phones (HZ-138). A task
-- about nobody keeps its own home. A handover's items, notes and acknowledgements carry its home
-- and shift end, and an item or note whether it is about nobody or about someone who still lives
-- at that home (`at_home`, as the person join did; no care-status rule, so a death in the shift
-- still reaches the handover).
ALTER TABLE "care_note" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "assessment" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "medication_administration" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "handover_acknowledgement" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "handover_acknowledgement" ADD COLUMN "shift_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handover_item" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "handover_item" ADD COLUMN "shift_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handover_note" ADD COLUMN "sync_location_id" uuid;--> statement-breakpoint
ALTER TABLE "handover_note" ADD COLUMN "shift_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handover_item" ADD COLUMN "at_home" boolean;--> statement-breakpoint
ALTER TABLE "handover_note" ADD COLUMN "at_home" boolean;--> statement-breakpoint

-- The statuses of a person receiving care: the whole-home streams carry only them (L1).
CREATE OR REPLACE FUNCTION app.receives_care(p_status public.person_status) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT p_status::text IN ('active', 'on_leave', 'in_hospital')
$$;
--> statement-breakpoint

-- The columns of a table that Postgres computes: not yet computed in a BEFORE trigger.
CREATE OR REPLACE FUNCTION app.generated_columns(p_table oid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(array_agg(attname::text), '{}') FROM pg_attribute
   WHERE attrelid = p_table AND attgenerated <> '' AND NOT attisdropped
$$;
--> statement-breakpoint

-- Whether this change touches the sync routing columns and nothing else (`sync_location_id`,
-- `at_home`, and `shift_end`, which the backfill copies once), as harbour_owner with the
-- transaction marked (app.move_sync_location, the backfill): the only change the guards below let
-- through. The record's content never changes.
CREATE OR REPLACE FUNCTION app.is_sync_location_move(p_table oid, p_new jsonb, p_old jsonb)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT current_user = 'harbour_owner'
     AND coalesce(current_setting('app.sync_location_move', true), '') = 'on'
     AND (p_new - ARRAY['sync_location_id', 'at_home', 'shift_end'] - app.generated_columns(p_table))
       = (p_old - ARRAY['sync_location_id', 'at_home', 'shift_end'] - app.generated_columns(p_table))
$$;
--> statement-breakpoint

-- Append-only tables refuse every change, with two exceptions: removing a sample batch (0069), and
-- moving `sync_location_id` and nothing else. The record's content never changes.
CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' AND current_user = 'harbour_sample_owner'
     AND current_setting('app.sample_removal', true) = 'on'
     AND TG_TABLE_NAME NOT IN ('audit_event', 'record_version') THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW'
     AND TG_TABLE_NAME NOT IN ('audit_event', 'record_version')
     AND app.is_sync_location_move(TG_RELID, to_jsonb(NEW), to_jsonb(OLD)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed; record a correction instead', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

-- A mutable row (a task) whose sync home moves keeps its version, so a phone's next write is not
-- refused as stale, and no history version is written: nothing in the record changed.
CREATE OR REPLACE FUNCTION app.touch_mutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_sync_location_move(TG_RELID, to_jsonb(NEW), to_jsonb(OLD)) THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'id cannot change on %', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) ->> 'tenant_id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'tenant_id') THEN
    RAISE EXCEPTION 'tenant_id cannot change on %', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(app.current_user_id(), NEW.updated_by);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.capture_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
BEGIN
  IF app.is_sync_location_move(TG_RELID, to_jsonb(NEW), old_row) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.record_version
    (tenant_id, table_name, record_id, record_version, valid_from, valid_to, changed_by, data)
  VALUES (
    COALESCE((old_row ->> 'tenant_id')::uuid, CASE WHEN TG_TABLE_NAME = 'tenant' THEN OLD.id END),
    TG_TABLE_NAME, OLD.id, OLD.version, OLD.updated_at, now(), app.current_user_id(), old_row
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- Existing rows. Row-level security is lifted for the owner for the backfill only, as in 0137, and
-- forced again after.
DO $$
DECLARE t text;
BEGIN
  PERFORM set_config('app.sync_location_move', 'on', true);
  ALTER TABLE public.person NO FORCE ROW LEVEL SECURITY;
  FOREACH t IN ARRAY ARRAY['care_note', 'observation', 'body_map_mark', 'assessment', 'activity_record', 'visit_log', 'medication_administration'] LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'UPDATE public.%I r SET sync_location_id = '
      'CASE WHEN app.receives_care(p.status) THEN p.location_id END '
      'FROM public.person p WHERE p.tenant_id = r.tenant_id AND p.id = r.person_id', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY;
  UPDATE public.task SET sync_location_id = location_id WHERE person_id IS NULL;
  UPDATE public.task r SET sync_location_id = CASE WHEN app.receives_care(p.status) THEN p.location_id END
    FROM public.person p WHERE p.tenant_id = r.tenant_id AND p.id = r.person_id;
  ALTER TABLE public.task FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.handover NO FORCE ROW LEVEL SECURITY;
  FOREACH t IN ARRAY ARRAY['handover_item', 'handover_note', 'handover_acknowledgement'] LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'UPDATE public.%I r SET shift_end = h.shift_end, sync_location_id = h.location_id '
      'FROM public.handover h WHERE h.tenant_id = r.tenant_id AND h.id = r.handover_id', t);
  END LOOP;
  UPDATE public.handover_item SET at_home = true;
  UPDATE public.handover_note SET at_home = true;
  UPDATE public.handover_item r SET at_home = false
    FROM public.person p WHERE p.tenant_id = r.tenant_id AND p.id = r.person_id
     AND p.location_id IS DISTINCT FROM r.sync_location_id;
  UPDATE public.handover_note r SET at_home = false
    FROM public.person p WHERE p.tenant_id = r.tenant_id AND p.id = r.person_id
     AND p.location_id IS DISTINCT FROM r.sync_location_id;
  FOREACH t IN ARRAY ARRAY['handover_item', 'handover_note', 'handover_acknowledgement'] LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  ALTER TABLE public.handover FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.person FORCE ROW LEVEL SECURITY;
  PERFORM set_config('app.sync_location_move', 'off', true);
END
$$;
--> statement-breakpoint

-- On insert, from the person now, whatever the client sent; a task about nobody keeps its home.
CREATE OR REPLACE FUNCTION app.set_sync_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'task' AND NEW.person_id IS NULL THEN
    NEW.sync_location_id := NEW.location_id;
    RETURN NEW;
  END IF;
  SELECT CASE WHEN app.receives_care(p.status) THEN p.location_id END INTO NEW.sync_location_id
    FROM public.person p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.person_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['care_note', 'observation', 'body_map_mark', 'assessment', 'activity_record', 'visit_log', 'medication_administration', 'task'] LOOP
    EXECUTE format(
      'CREATE TRIGGER set_sync_location BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.set_sync_location()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A handover's rows, on insert: its home and shift end; an item or note whether it is about nobody
-- or about someone who lives at the handover's home.
CREATE OR REPLACE FUNCTION app.set_handover_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  h_home uuid;
  p_home uuid;
BEGIN
  SELECT h.location_id, h.shift_end INTO h_home, NEW.shift_end FROM public.handover h
   WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.handover_id;
  NEW.sync_location_id := h_home;
  -- Nested, so `person_id` is read only on the two tables that have it.
  IF TG_TABLE_NAME <> 'handover_acknowledgement' THEN
    NEW.at_home := true;
    IF NEW.person_id IS NOT NULL THEN
      SELECT p.location_id INTO p_home FROM public.person p
       WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.person_id;
      NEW.at_home := p_home IS NOT DISTINCT FROM h_home;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['handover_item', 'handover_note', 'handover_acknowledgement'] LOOP
    EXECUTE format(
      'CREATE TRIGGER set_handover_sync BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.set_handover_sync()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- When a person's home changes, or they leave or return to care, their records of the last 35 days
-- (the longest sync window: the medicines administrations, ADR-0130; the offline window is at most
-- 31 days and tomorrow) and their tasks due from then on follow: to the new home's phones (HZ-138),
-- or off every home's phones once they have left care. As harbour_owner with the whole
-- organisation in view, so whoever records the move moves them all; the caller's scope returns.
CREATE OR REPLACE FUNCTION app.move_sync_location() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prev_scope text := current_setting('app.scope', true);
  since timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '35 days';
  target uuid := CASE WHEN app.receives_care(NEW.status) THEN NEW.location_id END;
  t text;
BEGIN
  IF NEW.location_id IS NOT DISTINCT FROM OLD.location_id
     AND app.receives_care(NEW.status) = app.receives_care(OLD.status) THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('app.scope', 'tenant', true);
  PERFORM set_config('app.sync_location_move', 'on', true);
  FOREACH t IN ARRAY ARRAY['care_note', 'observation', 'body_map_mark', 'assessment', 'activity_record', 'visit_log'] LOOP
    EXECUTE format(
      'UPDATE public.%I SET sync_location_id = $1 '
      'WHERE tenant_id = $2 AND person_id = $3 AND occurred_at >= $4 '
      'AND sync_location_id IS DISTINCT FROM $1', t)
      USING target, NEW.tenant_id, NEW.id, since;
  END LOOP;
  UPDATE public.medication_administration SET sync_location_id = target
   WHERE tenant_id = NEW.tenant_id AND person_id = NEW.id AND recorded_at >= since
     AND sync_location_id IS DISTINCT FROM target;
  UPDATE public.task SET sync_location_id = target
   WHERE tenant_id = NEW.tenant_id AND person_id = NEW.id AND due_at >= since
     AND sync_location_id IS DISTINCT FROM target;
  -- In the window's handovers, the items and notes about the person: at home only while they live
  -- at the handover's home (whatever their care status).
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    UPDATE public.handover_item r SET at_home = (h.location_id = NEW.location_id)
      FROM public.handover h
     WHERE h.tenant_id = r.tenant_id AND h.id = r.handover_id AND r.tenant_id = NEW.tenant_id
       AND r.person_id = NEW.id AND r.shift_end >= since;
    UPDATE public.handover_note r SET at_home = (h.location_id = NEW.location_id)
      FROM public.handover h
     WHERE h.tenant_id = r.tenant_id AND h.id = r.handover_id AND r.tenant_id = NEW.tenant_id
       AND r.person_id = NEW.id AND r.shift_end >= since;
  END IF;
  PERFORM set_config('app.sync_location_move', 'off', true);
  PERFORM set_config('app.scope', coalesce(prev_scope, ''), true);
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.move_sync_location() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER move_sync_location AFTER UPDATE OF location_id, status ON public.person
  FOR EACH ROW EXECUTE FUNCTION app.move_sync_location();
