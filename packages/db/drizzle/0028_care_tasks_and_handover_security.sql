-- Tasks, rounds and handover (Phase 1 slice 5; care.md rules 8 and 14, COMMS-006, hazards HZ-018
-- and HZ-011): the ADR-0002 patterns for the handover tables, and the location and person on
-- existing alerts. Runs as harbour_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['handover', 'handover_item', 'handover_note', 'handover_acknowledgement'] LOOP
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

-- A location's handovers are visible to tenant-wide roles, to location roles there, and to anyone
-- who can see at least one person at the location (an assigned care worker); each item is visible
-- only to those who can see its person (handover_item_scope). Invoker rights, like
-- app.person_in_scope: they run under the caller's row-level security, so they can never widen
-- access.
CREATE OR REPLACE FUNCTION app.handover_location_visible(p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE app.current_scope()
    WHEN 'tenant' THEN true
    WHEN 'locations' THEN p_location_id = ANY (app.current_location_ids())
      OR EXISTS (SELECT 1 FROM public.person p WHERE p.location_id = p_location_id)
    WHEN 'assigned' THEN EXISTS (SELECT 1 FROM public.person p WHERE p.location_id = p_location_id)
    ELSE false
  END
$$;
--> statement-breakpoint

-- Items, notes and acknowledgements follow their handover.
CREATE OR REPLACE FUNCTION app.handover_visible(p_handover_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.handover h WHERE h.id = p_handover_id)
$$;
--> statement-breakpoint

-- Whether the caller sees a handover whole: a tenant-wide role, or a location role at its location.
-- Everyone else sees it limited to their own people, and sees only their own acknowledgements.
CREATE OR REPLACE FUNCTION app.handover_whole(p_handover_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE app.current_scope()
    WHEN 'tenant' THEN true
    WHEN 'locations' THEN EXISTS (
      SELECT 1 FROM public.handover h
      WHERE h.id = p_handover_id AND h.location_id = ANY (app.current_location_ids()))
    ELSE false
  END
$$;
--> statement-breakpoint

-- Reading follows the location; writing a handover or its items is the system's alone (the API
-- and the worker compile in the organisation's view, scope 'tenant'), so no reader can add, change
-- or soft-delete one (HZ-018).
CREATE POLICY handover_scope ON public.handover AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.handover_location_visible(location_id));
--> statement-breakpoint
CREATE POLICY handover_system_insert ON public.handover AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE POLICY handover_system_update ON public.handover AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant')
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
-- An item about a person is visible only to those who can see that person (HZ-011).
CREATE POLICY handover_item_scope ON public.handover_item AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.handover_visible(handover_id) AND (person_id IS NULL OR app.person_visible(person_id)));
--> statement-breakpoint
CREATE POLICY handover_item_system_insert ON public.handover_item AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
-- A note on an item about a person follows that person's scope as well.
CREATE POLICY handover_child_scope ON public.handover_note AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.handover_visible(handover_id) AND (person_id IS NULL OR app.person_visible(person_id)))
  WITH CHECK (app.handover_visible(handover_id) AND (person_id IS NULL OR app.person_visible(person_id)));
--> statement-breakpoint
-- Nobody acknowledges a handover for someone else; a reader limited to their own people sees only
-- their own acknowledgements (each records the keys of the items its author could see).
CREATE POLICY handover_child_scope ON public.handover_acknowledgement AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.handover_visible(handover_id)
    AND (tenant_user_id = app.current_user_id() OR app.handover_whole(handover_id)))
  WITH CHECK (app.handover_visible(handover_id) AND tenant_user_id = app.current_user_id());
--> statement-breakpoint

-- The handover is mutable while it is compiled: version bump and history on every change.
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.handover
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.handover
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

-- Nothing safety-critical can be removed from a handover, only added to (HZ-018): its
-- organisation, location, shift and first compilation never change, it is never soft-deleted (the
-- retention schedule disposes of it with the care records it lists, by its own path), and a locked
-- handover stays locked. Its items are append-only rows of their own.
CREATE OR REPLACE FUNCTION app.handover_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.shift_name IS DISTINCT FROM OLD.shift_name
     OR NEW.shift_start IS DISTINCT FROM OLD.shift_start
     OR NEW.shift_end IS DISTINCT FROM OLD.shift_end
     OR NEW.compiled_at IS DISTINCT FROM OLD.compiled_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'A handover keeps its organisation, location, shift and first compilation, and is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION 'A locked handover stays locked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER handover_guard BEFORE UPDATE ON public.handover
  FOR EACH ROW EXECUTE FUNCTION app.handover_guard();
--> statement-breakpoint

-- A note on an item takes its person from the item, whatever the writer sent, and only an item the
-- writer can see may be annotated: the lookup runs under the writer's row-level security.
CREATE OR REPLACE FUNCTION app.handover_note_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_found boolean;
  v_person uuid;
BEGIN
  IF NEW.item_key IS NULL THEN
    NEW.person_id := NULL;
    RETURN NEW;
  END IF;
  SELECT true, i.person_id INTO v_found, v_person
    FROM public.handover_item i
    WHERE i.tenant_id = NEW.tenant_id AND i.handover_id = NEW.handover_id AND i.key = NEW.item_key;
  IF v_found IS NULL THEN
    RAISE EXCEPTION 'A note can only be on an item of its handover that its writer can see'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.person_id := v_person;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER handover_note_item BEFORE INSERT ON public.handover_note
  FOR EACH ROW EXECUTE FUNCTION app.handover_note_item();
--> statement-breakpoint

-- Items, notes and acknowledgements are append-only (Reg 17).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['handover_item', 'handover_note', 'handover_acknowledgement'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON public.handover TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.handover_item, public.handover_note, public.handover_acknowledgement
  TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.handover_item, public.handover_note,
  public.handover_acknowledgement FROM harbour_app;
--> statement-breakpoint

-- Alerts raised before this migration name their person and location from their source, so the
-- first handovers list the urgent ones still unacknowledged. FORCE is lifted for these statements
-- only (no tenant is set while migrating); notifications carry no version triggers.
-- backfill: begin
ALTER TABLE public.notification NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.observation NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assessment NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.statutory_notification NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.notification n SET person_id = s.person_id, location_id = s.location_id
  FROM public.task s
  WHERE n.source_type = 'task' AND s.tenant_id = n.tenant_id AND s.id::text = n.source_id
    AND n.location_id IS NULL;
--> statement-breakpoint
UPDATE public.notification n SET person_id = s.person_id, location_id = s.location_id
  FROM public.observation s
  WHERE n.source_type = 'observation' AND s.tenant_id = n.tenant_id AND s.id::text = n.source_id
    AND n.location_id IS NULL;
--> statement-breakpoint
UPDATE public.notification n SET person_id = s.person_id, location_id = s.location_id
  FROM public.assessment s
  WHERE n.source_type = 'assessment' AND s.tenant_id = n.tenant_id AND s.id::text = n.source_id
    AND n.location_id IS NULL;
--> statement-breakpoint
UPDATE public.notification n SET person_id = s.person_id, location_id = s.location_id
  FROM public.statutory_notification s
  WHERE n.source_type = 'statutory_notification' AND s.tenant_id = n.tenant_id
    AND s.id::text = n.source_id AND n.location_id IS NULL;
--> statement-breakpoint
-- Escalation copies take the alert they escalate.
UPDATE public.notification n SET person_id = o.person_id, location_id = o.location_id
  FROM public.notification o
  WHERE n.source_type = 'notification' AND o.tenant_id = n.tenant_id AND o.id::text = n.source_id
    AND n.location_id IS NULL;
--> statement-breakpoint
ALTER TABLE public.notification FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.observation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assessment FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.statutory_notification FORCE ROW LEVEL SECURITY;
-- backfill: end
