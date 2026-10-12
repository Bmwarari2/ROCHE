-- Hand-overs and device sessions (care.md section 6, Device integrity parts 2 and 6; the #25
-- reviews, rounds 2 and 3; hazards HZ-011 and HZ-040): the ADR-0002 patterns for device_session
-- and handed_over_entry, and the function that admits a handed-over entry in the entry's own
-- transaction. Both tables are append-only. Runs as harbour_owner.

ALTER TABLE public.device_session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.device_session FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.device_session AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- A member reads the sessions bound to their own devices (the API checks each request's session in
-- the member's own view), and binds only their own, in the system's view acting for them; a job
-- with no member reads them all. A tenant-wide role never reads another member's sessions.
CREATE POLICY device_session_scope ON public.device_session AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (tenant_user_id = app.current_user_id()
    OR (app.current_user_id() IS NULL AND app.current_scope() = 'tenant'));
--> statement-breakpoint
CREATE POLICY device_session_system_insert ON public.device_session AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant' AND tenant_user_id = app.current_user_id());
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.device_session
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.device_session
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.device_session TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.device_session FROM harbour_app;
--> statement-breakpoint

ALTER TABLE public.handed_over_entry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.handed_over_entry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.handed_over_entry AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- The sender and the owner read their own hand-overs; tenant-wide roles read the organisation's,
-- and location roles those of owners with a live role assignment at one of their locations.
-- Writing is the system's (the admission function below).
CREATE POLICY handed_over_entry_scope ON public.handed_over_entry AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant'
    OR sent_by = app.current_user_id()
    OR owner_tenant_user_id = app.current_user_id()
    OR (app.current_scope() = 'locations' AND EXISTS (
      SELECT 1 FROM public.role_assignment ra
      WHERE ra.tenant_id = handed_over_entry.tenant_id
        AND ra.tenant_user_id = handed_over_entry.owner_tenant_user_id
        AND ra.location_id = ANY (app.current_location_ids())
        AND ra.deleted_at IS NULL AND ra.valid_from <= now()
        AND (ra.valid_to IS NULL OR ra.valid_to > now()))));
--> statement-breakpoint
CREATE POLICY handed_over_entry_system_insert ON public.handed_over_entry AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.handed_over_entry
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.handed_over_entry
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.handed_over_entry TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.handed_over_entry FROM harbour_app;
--> statement-breakpoint

-- Admits one handed-over entry inside the transaction that writes it (#25 review round 3, low), so
-- an entry the API then refuses uses up none of the hold's count. Called by the sender only, with
-- the hold's count and when its report was made, worked out by the API beforehand. One hand-over id
-- at a time (so two owners cannot race one id), then one hold at a time: the id must name this
-- owner, device and sender only; an entry already admitted for the owner passes again without
-- counting; otherwise the entries admitted since the report must be fewer than its count. Returns
-- null when admitted, else the reason, in words. It works in the system's view and restores the
-- caller's view before it returns.
CREATE OR REPLACE FUNCTION app.admit_handed_over_entry(
  p_handover uuid, p_device uuid, p_owner uuid, p_sender uuid, p_table text, p_entry uuid,
  p_since timestamptz, p_limit integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_scope text := coalesce(current_setting('app.scope', true), '');
  v_used record;
  v_admitted uuid;
  v_sent integer;
  v_reason text;
BEGIN
  IF v_tenant IS NULL OR p_sender IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A hand-over is admitted only for the member sending it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant::text || ':handover_id:' || p_handover::text));
  PERFORM pg_advisory_xact_lock(
    hashtext(v_tenant::text || ':handover:' || p_device::text || ':' || p_owner::text));
  PERFORM set_config('app.scope', 'tenant', true);
  SELECT owner_tenant_user_id, device_id, sent_by INTO v_used FROM public.handed_over_entry
    WHERE tenant_id = v_tenant AND handover_id = p_handover LIMIT 1;
  IF FOUND AND (v_used.owner_tenant_user_id <> p_owner OR v_used.device_id <> p_device
      OR v_used.sent_by <> p_sender) THEN
    v_reason := 'That hand-over id is already used for another member of staff, device or sender.';
  ELSE
    SELECT owner_tenant_user_id INTO v_admitted FROM public.handed_over_entry
      WHERE tenant_id = v_tenant AND record_table = p_table AND entry_id = p_entry;
    IF FOUND THEN
      IF v_admitted <> p_owner THEN
        v_reason := 'That entry was sent for another member of staff.';
      END IF;
    ELSE
      SELECT count(*) INTO v_sent FROM public.handed_over_entry
        WHERE tenant_id = v_tenant AND device_id = p_device AND owner_tenant_user_id = p_owner
          AND accepted_at > p_since;
      IF v_sent >= p_limit THEN
        v_reason := format(
          'All %s entries the device reported waiting for this member of staff have been sent.',
          p_limit);
      ELSE
        INSERT INTO public.handed_over_entry (tenant_id, handover_id, device_id,
            owner_tenant_user_id, sent_by, record_table, entry_id, accepted_at)
          VALUES (v_tenant, p_handover, p_device, p_owner, p_sender, p_table, p_entry,
            clock_timestamp());
      END IF;
    END IF;
  END IF;
  PERFORM set_config('app.scope', v_scope, true);
  RETURN v_reason;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.admit_handed_over_entry(uuid, uuid, uuid, uuid, text, uuid, timestamptz,
  integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.admit_handed_over_entry(uuid, uuid, uuid, uuid, text, uuid,
  timestamptz, integer) TO harbour_app;
