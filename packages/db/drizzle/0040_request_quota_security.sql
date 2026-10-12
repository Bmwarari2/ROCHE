-- Shared per-user request limits (care.md section 6, Device integrity part 7; platform.md): the
-- ADR-0002 patterns for request_quota. Runs as harbour_owner.

ALTER TABLE public.request_quota ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.request_quota FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.request_quota AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- A member's requests count against their own limits only, in a view acting as that member (the
-- API counts a hand-over's copies in the owner's own view); a job with no member (tenant scope, no
-- user) may count for anyone. A tenant-wide role never reads or moves another member's hits
-- (#25 review round 2, low).
CREATE POLICY request_quota_own ON public.request_quota AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (tenant_user_id = app.current_user_id()
    OR (app.current_user_id() IS NULL AND app.current_scope() = 'tenant'))
  WITH CHECK (tenant_user_id = app.current_user_id()
    OR (app.current_user_id() IS NULL AND app.current_scope() = 'tenant'));
--> statement-breakpoint

-- Overwritten in place (no version history: the hits are operational and kept for a window only);
-- no DELETE for the application, as everywhere.
GRANT SELECT, INSERT, UPDATE ON public.request_quota TO harbour_app;
