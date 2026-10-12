-- Hand-overs and device sessions (care.md section 6, Device integrity parts 2 and 6; the #25
-- review round 2, security H1 and M1; hazards HZ-011 and HZ-040): the ADR-0002 patterns for
-- device_session and handed_over_entry. Both are written only in the system's view, after the API
-- has made its checks, and are append-only. Runs as harbour_owner.

ALTER TABLE public.device_session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.device_session FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.device_session AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- A member reads the sessions bound to their own devices (the API checks each request's session in
-- the member's own view); the system's view reads and writes them all. Nobody else reads them.
CREATE POLICY device_session_scope ON public.device_session AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant' OR tenant_user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY device_session_system_insert ON public.device_session AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
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
-- and location roles those of owners working at one of their locations. Writing is the system's.
CREATE POLICY handed_over_entry_scope ON public.handed_over_entry AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant'
    OR sent_by = app.current_user_id()
    OR owner_tenant_user_id = app.current_user_id()
    OR (app.current_scope() = 'locations' AND EXISTS (
      SELECT 1 FROM public.role_assignment ra
      WHERE ra.tenant_id = handed_over_entry.tenant_id
        AND ra.tenant_user_id = handed_over_entry.owner_tenant_user_id
        AND ra.location_id = ANY (app.current_location_ids()))));
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
