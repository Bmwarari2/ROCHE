-- Server copies of refused entries (care.md section 6, Device integrity part 5; hazards HZ-006 and
-- HZ-011): the ADR-0002 patterns for refused_entry. Runs as harbour_owner.

ALTER TABLE public.refused_entry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.refused_entry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.refused_entry AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- Read like the care record it would have been: a copy about a person follows that person's
-- visibility (scope, assignments, break-glass); a copy about nobody known only tenant-wide roles
-- and roles at its location. Invoker rights, so they never widen access.
CREATE POLICY refused_entry_scope ON public.refused_entry AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (
    (person_id IS NOT NULL AND app.person_visible(person_id))
    OR (person_id IS NULL AND (app.current_scope() = 'tenant'
      OR (location_id IS NOT NULL AND location_id = ANY (app.current_location_ids())))));
--> statement-breakpoint
-- Written only in the system's view (the API, once it has checked the author), because the author
-- may no longer see the person the entry is about (an assignment ended, a person discharged).
CREATE POLICY refused_entry_system_insert ON public.refused_entry AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint

-- Append-only, like the care entries it copies (Reg 17).
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.refused_entry
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.refused_entry
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.refused_entry TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.refused_entry FROM harbour_app;
