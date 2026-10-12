-- Downtime packs and outages (slice 11; operations.md sections 2 and 3; hazards HZ-011, HZ-017 and
-- HZ-021): the ADR-0002 patterns, with each request in the scope of its permission (ADR-0071).
-- Runs as harbour_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['downtime_pack', 'outage'] LOOP
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

-- A downtime pack follows its location, and its content the people on it: tenant-wide scope, or
-- location scope at its location, and then only when the caller can see every person on it. A
-- person who has since moved away hides the pack from the old location (fails closed). Invoker
-- rights, like app.person_in_scope: it runs under the caller's row-level security, so it can never
-- widen access.
CREATE OR REPLACE FUNCTION app.downtime_pack_visible(p_location_id uuid, p_person_ids uuid[])
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE app.current_scope()
      WHEN 'tenant' THEN true
      WHEN 'locations' THEN p_location_id = ANY (app.current_location_ids())
      ELSE false
    END
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p_person_ids) AS pp(id) WHERE NOT app.person_visible(pp.id))
$$;
--> statement-breakpoint
CREATE POLICY downtime_pack_scope ON public.downtime_pack AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.downtime_pack_visible(location_id, person_ids))
  WITH CHECK (app.downtime_pack_visible(location_id, person_ids));
--> statement-breakpoint
-- The permission as well as its scope: a member reads or builds a location's pack only where they
-- hold operations.downtime.read, and builds it in their own name; the nightly job, with no member,
-- keeps the organisation's view.
CREATE POLICY downtime_pack_permission ON public.downtime_pack AS RESTRICTIVE FOR ALL TO harbour_app
  USING ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('operations.downtime.read', location_id))
  WITH CHECK (generated_by IS NOT DISTINCT FROM app.current_user_id() AND (
    (app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('operations.downtime.read', location_id)));
--> statement-breakpoint

-- An outage is visible to tenant-wide roles, to location roles there, and to anyone who can see a
-- person at the location (an assigned care worker, whose entries it may cover), as a location's
-- handovers are. Invoker rights.
CREATE OR REPLACE FUNCTION app.outage_visible(p_location_id uuid) RETURNS boolean
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
CREATE POLICY outage_scope ON public.outage AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.outage_visible(location_id))
  WITH CHECK (app.outage_visible(location_id));
--> statement-breakpoint
-- Declaring, closing, reconciling and cancelling need operations.downtime.manage where the outage
-- is, and a declaration is in the declarer's own name; a job with no member keeps the
-- organisation's view.
CREATE POLICY outage_write ON public.outage AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR (declared_by = app.current_user_id()
      AND app.holds_permission_at('operations.downtime.manage', location_id)));
--> statement-breakpoint
CREATE POLICY outage_change ON public.outage AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('operations.downtime.manage', location_id))
  WITH CHECK ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('operations.downtime.manage', location_id));
--> statement-breakpoint

-- Outage windows at a location never overlap (operations.md rule 9), whatever the caller can see.
-- Windows are half-open, and an open outage runs on until it closes; cancelled ones do not count.
ALTER TABLE public.outage ADD CONSTRAINT outage_no_overlap EXCLUDE USING gist (
  tenant_id WITH =,
  location_id WITH =,
  tstzrange(started_at, ended_at, '[)') WITH &&
) WHERE (state <> 'cancelled' AND deleted_at IS NULL);
--> statement-breakpoint

-- The window back-entries rely on (HZ-017): an outage keeps its location, start and declaration;
-- it moves only along OUTAGE_WORKFLOW, in the name of the member moving it; its end and closure
-- are set once, when it closes; a reconciled or cancelled outage is final; and it is never
-- soft-deleted (the retention engine disposes of it by its own path).
CREATE OR REPLACE FUNCTION app.outage_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.declared_at IS DISTINCT FROM OLD.declared_at
     OR NEW.declared_by IS DISTINCT FROM OLD.declared_by
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'An outage keeps its location, start and declaration, and is never deleted'
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
  END IF;
  IF (NEW.ended_at, NEW.closed_at, NEW.closed_by, NEW.back_entry_due_at) IS DISTINCT FROM
       (OLD.ended_at, OLD.closed_at, OLD.closed_by, OLD.back_entry_due_at)
     AND NOT (OLD.state = 'declared' AND NEW.state = 'closed') THEN
    RAISE EXCEPTION 'An outage''s end and closure are set once, when it closes'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER outage_guard BEFORE UPDATE ON public.outage
  FOR EACH ROW EXECUTE FUNCTION app.outage_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.outage
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.outage
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

-- A downtime pack is append-only: a newer pack replaces it, nothing changes it.
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.downtime_pack
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.downtime_pack
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

GRANT SELECT, INSERT ON public.downtime_pack TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.downtime_pack FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.outage TO harbour_app;
