-- The residential people lifecycle (slice 8): the ADR-0002 patterns of migrations 0012, 0017 and
-- 0019, the bed occupancy exclusion constraints (people.md rule 6), the backfills for the new
-- person columns (expand only) and the powersync publication. Runs as harbour_owner. The enum
-- values added in 0020 are not used here: a value added by ALTER TYPE cannot be used in the same
-- transaction, and the migrator applies pending migrations in one transaction.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pre_admission_assessment', 'admission_decision', 'admission_condition', 'bed_occupancy',
    'welcome_checklist_template', 'welcome_checklist_item', 'property_item', 'key_issue',
    'care_plan_change', 'review_record', 'hospital_transfer', 'exit_record', 'exit_checklist_item',
    'sharing_decision', 'about_me_share_link', 'break_glass_weekly_report'
  ] LOOP
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

-- Everything about one person follows that person's scope (tenant-wide roles, their location,
-- assigned staff, an open break-glass record).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pre_admission_assessment', 'admission_decision', 'admission_condition', 'bed_occupancy',
    'welcome_checklist_item', 'property_item', 'key_issue', 'care_plan_change', 'review_record',
    'hospital_transfer', 'exit_record', 'exit_checklist_item', 'sharing_decision',
    'about_me_share_link'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- The weekly break-glass report holds counts and opaque ids for one location: tenant-wide roles
-- and the people working at that location (the Registered Manager) read it.
CREATE POLICY break_glass_report_scope ON public.break_glass_weekly_report AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant' OR location_id = ANY (app.current_location_ids()))
  WITH CHECK (app.current_scope() = 'tenant' OR location_id = ANY (app.current_location_ids()));
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Rooms, beds and moves (people.md rule 6; HZ-001). The domain plans each move; these constraints
-- are the backstop, and they hold whatever the caller can see: a bed never has two occupants on
-- the same day and a person never occupies two beds. Periods are half-open [from_date, to_date).
--------------------------------------------------------------------------------------------------

ALTER TABLE public.bed_occupancy ADD CONSTRAINT bed_occupancy_bed_no_overlap EXCLUDE USING gist (
  tenant_id WITH =,
  room_id WITH =,
  bed WITH =,
  daterange(from_date, to_date, '[)') WITH &&
) WHERE (deleted_at IS NULL);
--> statement-breakpoint
ALTER TABLE public.bed_occupancy ADD CONSTRAINT bed_occupancy_person_no_overlap EXCLUDE USING gist (
  tenant_id WITH =,
  person_id WITH =,
  daterange(from_date, to_date, '[)') WITH &&
) WHERE (deleted_at IS NULL);
--> statement-breakpoint


--------------------------------------------------------------------------------------------------
-- person.status_changed_at (people.md rules 2 and 3). The API sets it with every status change;
-- a writer that changes only the status (an older app version, a seed or a script) gets the exit
-- time for a discharge or death and the current time otherwise, so rule 3 never compares an event
-- with a stale status time.
--------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.person_status_changed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status_changed_at IS NOT DISTINCT FROM OLD.status_changed_at THEN
    NEW.status_changed_at := COALESCE(
      CASE NEW.status::text
        WHEN 'discharged' THEN NEW.discharged_at
        WHEN 'deceased' THEN NEW.deceased_at
      END,
      now()
    );
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Backfills for the columns added in 0020, inside this migration's transaction. The owner is
-- subject to row-level security on every table (FORCE), and no tenant is set while migrating, so
-- FORCE is lifted for these statements only and restored before the transaction commits. The
-- versioning triggers are paused because filling a new column is not a change to the record: a
-- client holding the current version must not be refused as stale.
ALTER TABLE public.person NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.placement NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bed_occupancy NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.person DISABLE TRIGGER touch_mutable;
--> statement-breakpoint
ALTER TABLE public.person DISABLE TRIGGER capture_version;
--> statement-breakpoint

-- When the current status began: the exit for a discharge or death, otherwise the earliest
-- certain time (creation), so that no genuine change is refused as earlier than the status.
UPDATE public.person SET status_changed_at = CASE status::text
    WHEN 'discharged' THEN COALESCE(discharged_at, created_at)
    WHEN 'deceased' THEN COALESCE(deceased_at, created_at)
    WHEN 'archived' THEN COALESCE(deceased_at, discharged_at, created_at)
    ELSE created_at
  END;
--> statement-breakpoint

-- A list that already holds needs is a record of them; an empty list stays "not recorded" until
-- someone confirms that there are none (HZ-023).
UPDATE public.person SET communication_needs_status = 'recorded'
  WHERE jsonb_typeof(communication_needs) = 'array' AND jsonb_array_length(communication_needs) > 0;
--> statement-breakpoint

-- The bed history starts from each live person's current placement and room (bed 1). A clash
-- with someone else's period is left out rather than failing the migration; the bed board shows
-- the room as needing a check.
INSERT INTO public.bed_occupancy (tenant_id, person_id, room_id, bed, from_date, reason, created_by,
    updated_by)
  SELECT pl.tenant_id, pl.person_id, pl.room_id, 1, pl.start_date,
    'Recorded before the bed history began', NULL, NULL
  FROM public.placement pl
  JOIN public.person p ON p.id = pl.person_id AND p.tenant_id = pl.tenant_id
  WHERE pl.room_id IS NOT NULL AND pl.end_date IS NULL AND pl.deleted_at IS NULL
    AND p.deleted_at IS NULL AND p.status::text IN ('active', 'on_leave', 'in_hospital')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint

ALTER TABLE public.person ENABLE TRIGGER touch_mutable;
--> statement-breakpoint
ALTER TABLE public.person ENABLE TRIGGER capture_version;
--> statement-breakpoint
ALTER TABLE public.person FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.placement FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bed_occupancy FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TRIGGER person_status_changed_at BEFORE UPDATE OF status ON public.person
  FOR EACH ROW EXECUTE FUNCTION app.person_status_changed_at();
--> statement-breakpoint

-- A period names a bed the room has (beds are numbered 1 to room.beds). Invoker rights: the room
-- is read under the caller's row-level security, so the trigger is created after the backfill.
CREATE OR REPLACE FUNCTION app.bed_occupancy_bed_in_room() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.room r WHERE r.id = NEW.room_id AND NEW.bed <= r.beds) THEN
    RAISE EXCEPTION 'bed_occupancy: the room does not have that bed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bed_occupancy_bed_in_room BEFORE INSERT OR UPDATE OF room_id, bed
  ON public.bed_occupancy FOR EACH ROW EXECUTE FUNCTION app.bed_occupancy_bed_in_room();
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Versioning, append-only rules and grants
--------------------------------------------------------------------------------------------------

-- Mutable aggregates: version bump on every change and a record_version row (history view).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pre_admission_assessment', 'admission_condition', 'bed_occupancy',
    'welcome_checklist_template', 'welcome_checklist_item', 'property_item', 'key_issue',
    'care_plan_change', 'hospital_transfer', 'exit_record', 'exit_checklist_item',
    'sharing_decision', 'about_me_share_link'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format(
      'CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Decisions to admit, review records and weekly reports are append-only: a correction or a review
-- is a new row that supersedes the original (Reg 17, HZ-017, HZ-011).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admission_decision', 'review_record', 'break_glass_weekly_report'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON public.pre_admission_assessment, public.admission_condition,
  public.bed_occupancy, public.welcome_checklist_template, public.welcome_checklist_item,
  public.property_item, public.key_issue, public.care_plan_change, public.hospital_transfer,
  public.exit_record, public.exit_checklist_item, public.sharing_decision,
  public.about_me_share_link TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.admission_decision, public.review_record,
  public.break_glass_weekly_report TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.admission_decision, public.review_record,
  public.break_glass_weekly_report FROM harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.pre_admission_assessment, public.admission_condition,
  public.bed_occupancy, public.welcome_checklist_template, public.welcome_checklist_item,
  public.property_item, public.key_issue, public.care_plan_change, public.hospital_transfer,
  public.exit_record, public.exit_checklist_item, public.sharing_decision,
  public.about_me_share_link FROM harbour_app;
--> statement-breakpoint

-- Devices hold About Me for their assigned people (people.md section 7) and build the hospital
-- transfer pack offline from synced data: the pre-admission medicines list (until the eMAR in
-- Phase 2) and the belongings that travel with the person. Contacts stay off devices (the
-- isolation test guards it), so the offline pack names the home's contact details only. Sync
-- streams decide what reaches a device; logical replication bypasses RLS and the initial
-- snapshot is this SELECT. Status changes, exits, sharing and share links stay on the server.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['about_me', 'pre_admission_assessment', 'property_item'] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.about_me, public.pre_admission_assessment, public.property_item
  TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.about_me, public.pre_admission_assessment,
  public.property_item;
