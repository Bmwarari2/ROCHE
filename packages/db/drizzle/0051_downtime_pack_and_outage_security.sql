-- Downtime packs and outages (slice 11; operations.md sections 2 and 3; hazards HZ-011, HZ-017 and
-- HZ-021): the ADR-0002 patterns, with each request in the scope of its permission (ADR-0071),
-- and the location's MAR and PEEP places. Runs as harbour_owner.

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

-- Whether an outage was declared more than care_note.late_entry_hours after it began (rule 9),
-- worked out here rather than taken from the caller: the figure in force for the location's nation
-- on the UK date of the declaration, the organisation's own first, then the nation's, the UK's and
-- all, as resolveRate chooses. With no figure it reads as late, so someone looks at it.
CREATE OR REPLACE FUNCTION app.outage_declared_late(
  p_location_id uuid, p_started_at timestamptz, p_declared_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p_declared_at - p_started_at > interval '1 hour' * (
    SELECT r.value FROM public.rate_table r, public.location l
    WHERE l.id = p_location_id AND r.key = 'care_note.late_entry_hours'
      AND r.nation IN (l.nation::text, 'uk', 'all')
      AND r.valid_from <= (p_declared_at AT TIME ZONE 'Europe/London')::date
      AND (r.valid_to IS NULL OR r.valid_to > (p_declared_at AT TIME ZONE 'Europe/London')::date)
      AND (r.tenant_id IS NULL OR r.tenant_id = app.current_tenant_id())
    ORDER BY r.tenant_id IS NOT NULL DESC,
      CASE r.nation WHEN l.nation::text THEN 3 WHEN 'uk' THEN 2 ELSE 1 END DESC
    LIMIT 1), true)
$$;
--> statement-breakpoint

-- An outage is declared open (#32 review round 1, M1): nothing closed, reconciled, cancelled or
-- corrected yet; declared now, whatever the caller sends; and whether it was declared late is
-- worked out here. Its end may be given when it is declared after it ended (rule 9).
CREATE OR REPLACE FUNCTION app.outage_declare() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'declared'
     OR num_nonnulls(NEW.closed_at, NEW.closed_by, NEW.back_entry_due_at, NEW.reconciled_at,
          NEW.reconciled_by, NEW.reconciliation_statement, NEW.forms_entered, NEW.cancelled_at,
          NEW.cancelled_by, NEW.cancellation_reason, NEW.correction_reason, NEW.deleted_at) > 0
     OR cardinality(NEW.reviewed_entry_ids) > 0 THEN
    RAISE EXCEPTION 'An outage is declared open, with nothing closed, reconciled, cancelled or corrected yet'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.declared_at := now();
  NEW.declared_late := app.outage_declared_late(NEW.location_id, NEW.started_at, NEW.declared_at);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER outage_declare BEFORE INSERT ON public.outage
  FOR EACH ROW EXECUTE FUNCTION app.outage_declare();
--> statement-breakpoint

-- The window back-entries rely on (HZ-017): an outage keeps its location and declaration (when,
-- by whom, and whether late, which follows a corrected start); it moves only along
-- OUTAGE_WORKFLOW, in the name of the member moving it; its closure is set once, when it closes,
-- and closing sets its end; otherwise its start and end change only by a correction with a reason
-- of its own, before it is reconciled (#32 review round 1, clinical M3: the clock change), an open
-- outage staying open; a reconciled or cancelled outage is final; and it is never soft-deleted
-- (the retention engine disposes of it by its own path).
CREATE OR REPLACE FUNCTION app.outage_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_closing boolean := OLD.state = 'declared' AND NEW.state = 'closed';
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

-- The people a pack names are the ones in its content (#32 review round 1, M2): everyone with a
-- page and everyone left out, worked out here whatever the caller sends, so the policy above can
-- never be told less than the pack holds. A pack without its pages, or a page or exclusion that
-- names no person, is refused.
CREATE OR REPLACE FUNCTION app.downtime_pack_people() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.content -> 'pages') IS DISTINCT FROM 'array'
     OR jsonb_typeof(COALESCE(NEW.content -> 'excluded', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'A downtime pack lists its pages, and anyone left out, as arrays'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.person_ids := ARRAY(
    SELECT DISTINCT (e ->> 'personId')::uuid
    FROM jsonb_array_elements((NEW.content -> 'pages') || COALESCE(NEW.content -> 'excluded', '[]'::jsonb)) AS e
    ORDER BY 1);
  IF array_position(NEW.person_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Every page of a downtime pack, and everyone left out, names their person'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER downtime_pack_people BEFORE INSERT ON public.downtime_pack
  FOR EACH ROW EXECUTE FUNCTION app.downtime_pack_people();
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
--> statement-breakpoint

-- Where the paper MAR and the PEEPs are kept (#32 review round 1, clinical M2 and security low):
-- only a holder of platform.location.manage at the location (or a job with no member) changes or
-- confirms them; a confirmation is in the confirmer's own name and dated now; a place changed
-- without a confirmation is unconfirmed again; a new location starts unconfirmed.
CREATE OR REPLACE FUNCTION app.location_downtime_places() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.downtime_places_confirmed_at IS NOT NULL OR NEW.downtime_places_confirmed_by IS NOT NULL THEN
      RAISE EXCEPTION 'A new location''s MAR and PEEP places start unconfirmed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.downtime_mar_location, NEW.downtime_peep_location, NEW.downtime_places_confirmed_at,
      NEW.downtime_places_confirmed_by) IS NOT DISTINCT FROM (OLD.downtime_mar_location,
      OLD.downtime_peep_location, OLD.downtime_places_confirmed_at, OLD.downtime_places_confirmed_by) THEN
    RETURN NEW;
  END IF;
  IF NOT ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
          OR app.holds_permission_at('platform.location.manage', NEW.id)) THEN
    RAISE EXCEPTION 'Only a holder of platform.location.manage here changes where the MAR and PEEPs are kept'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.downtime_places_confirmed_by IS NOT NULL
     AND (NEW.downtime_places_confirmed_at, NEW.downtime_places_confirmed_by)
       IS DISTINCT FROM (OLD.downtime_places_confirmed_at, OLD.downtime_places_confirmed_by) THEN
    IF app.current_user_id() IS NOT NULL
       AND NEW.downtime_places_confirmed_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'The MAR and PEEP places are confirmed in the name of the member confirming them'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.downtime_places_confirmed_at := now();
  ELSIF (NEW.downtime_mar_location, NEW.downtime_peep_location)
          IS DISTINCT FROM (OLD.downtime_mar_location, OLD.downtime_peep_location) THEN
    NEW.downtime_places_confirmed_at := NULL;
    NEW.downtime_places_confirmed_by := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER location_downtime_places BEFORE INSERT OR UPDATE ON public.location
  FOR EACH ROW EXECUTE FUNCTION app.location_downtime_places();
