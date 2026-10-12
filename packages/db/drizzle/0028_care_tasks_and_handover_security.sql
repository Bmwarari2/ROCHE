-- Tasks, rounds and handover (Phase 1 slice 5; care.md rules 8 and 14, COMMS-006, hazards HZ-018
-- and HZ-011): the ADR-0002 patterns for the handover tables, and the location and person on
-- existing alerts. Runs as harbour_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['handover', 'handover_note', 'handover_acknowledgement'] LOOP
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
-- who can see at least one person at the location (an assigned care worker); the items about
-- people they cannot see are filtered out by the API. Invoker rights, like app.person_in_scope:
-- they run under the caller's row-level security, so they can never widen access.
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

-- Notes and acknowledgements follow their handover.
CREATE OR REPLACE FUNCTION app.handover_visible(p_handover_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.handover h WHERE h.id = p_handover_id)
$$;
--> statement-breakpoint

CREATE POLICY handover_scope ON public.handover AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.handover_location_visible(location_id))
  WITH CHECK (app.handover_location_visible(location_id));
--> statement-breakpoint
-- A note on an item about a person follows that person's scope as well.
CREATE POLICY handover_child_scope ON public.handover_note AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.handover_visible(handover_id) AND (person_id IS NULL OR app.person_visible(person_id)))
  WITH CHECK (app.handover_visible(handover_id) AND (person_id IS NULL OR app.person_visible(person_id)));
--> statement-breakpoint
-- Nobody acknowledges a handover for someone else.
CREATE POLICY handover_child_scope ON public.handover_acknowledgement AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.handover_visible(handover_id))
  WITH CHECK (app.handover_visible(handover_id) AND tenant_user_id = app.current_user_id());
--> statement-breakpoint

-- The handover is mutable while it is compiled: version bump and history on every change.
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.handover
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.handover
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

-- Nothing safety-critical can be removed from a handover, only added to (HZ-018): every item it
-- held stays, unchanged and in its place; its location, shift and first compilation never change;
-- and a locked handover stays locked. Defence in depth behind checkHandoverKeepsItems.
CREATE OR REPLACE FUNCTION app.handover_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.shift_name IS DISTINCT FROM OLD.shift_name
     OR NEW.shift_start IS DISTINCT FROM OLD.shift_start
     OR NEW.shift_end IS DISTINCT FROM OLD.shift_end
     OR NEW.compiled_at IS DISTINCT FROM OLD.compiled_at THEN
    RAISE EXCEPTION 'A handover keeps its location, shift and first compilation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION 'A locked handover stays locked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF jsonb_array_length(NEW.items) < jsonb_array_length(OLD.items) OR EXISTS (
    SELECT 1 FROM generate_series(0, jsonb_array_length(OLD.items) - 1) AS i
    WHERE NEW.items -> i IS DISTINCT FROM OLD.items -> i
  ) THEN
    RAISE EXCEPTION 'Handover items cannot be removed or changed, only added to'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER handover_guard BEFORE UPDATE ON public.handover
  FOR EACH ROW EXECUTE FUNCTION app.handover_guard();
--> statement-breakpoint

-- Notes and acknowledgements are append-only (Reg 17).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['handover_note', 'handover_acknowledgement'] LOOP
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
GRANT SELECT, INSERT ON public.handover_note, public.handover_acknowledgement TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.handover_note, public.handover_acknowledgement
  FROM harbour_app;
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
