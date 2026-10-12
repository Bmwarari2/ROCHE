-- Deletion lists (care.md section 6, Device integrity part 3; hazards HZ-011 and HZ-040, the
-- go-live blocker): the ADR-0002 patterns for device_discard_entry, and its first rows from the
-- deletion records already in the audit trail. Runs as harbour_owner.

ALTER TABLE public.device_discard_entry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.device_discard_entry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.device_discard_entry AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- A member reads and writes the lists of their own deletions. Tenant-wide and location roles (the
-- managers who may record anyone's deletion, which the API checks first) write the organisation's;
-- tenant-wide roles read them all, and a location role those of owners with a live role assignment at
-- one of its locations (#25 review round 2, low).
CREATE POLICY device_discard_entry_scope ON public.device_discard_entry AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant'
    OR owner_tenant_user_id = app.current_user_id()
    OR (app.current_scope() = 'locations' AND EXISTS (
      SELECT 1 FROM public.role_assignment ra
      WHERE ra.tenant_id = device_discard_entry.tenant_id
        AND ra.tenant_user_id = device_discard_entry.owner_tenant_user_id
        AND ra.location_id = ANY (app.current_location_ids())
        AND ra.deleted_at IS NULL AND ra.valid_from <= now()
        AND (ra.valid_to IS NULL OR ra.valid_to > now()))));
--> statement-breakpoint
CREATE POLICY device_discard_entry_write ON public.device_discard_entry AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() IN ('tenant', 'locations')
    OR owner_tenant_user_id = app.current_user_id());
--> statement-breakpoint

-- Append-only, like the audit events it indexes.
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.device_discard_entry
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.device_discard_entry
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.device_discard_entry TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.device_discard_entry FROM harbour_app;
--> statement-breakpoint

-- The first rows: every entry id each stage of an existing deletion record lists, with its owner
-- when that owner is staff here, at the time the stage was recorded. Run in each tenant's view;
-- FORCE is lifted on the audit trail only to find the tenants and restored at the end. Idempotent.
-- backfill: begin
ALTER TABLE public.audit_event NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.audit_event
           WHERE resource_type = 'device_discard' AND tenant_id IS NOT NULL ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    INSERT INTO public.device_discard_entry (tenant_id, discard_id, stage, entry_id,
        owner_tenant_user_id, recorded_at, created_at)
      SELECT a.tenant_id, lower(a.resource_id)::uuid, s.stage, lower(e.id)::uuid,
        CASE WHEN EXISTS (SELECT 1 FROM public.tenant_user u
                          WHERE u.tenant_id = a.tenant_id
                            AND u.id::text = lower(a.scope ->> 'ownerTenantUserId'))
             THEN lower(a.scope ->> 'ownerTenantUserId')::uuid END,
        a.occurred_at, now()
      FROM public.audit_event a
      JOIN (VALUES ('sync.entries.discard_requested', 'requested'),
                   ('sync.entries.discarded', 'deleted'),
                   ('sync.entries.discard_failed', 'failed')) AS s(action, stage)
        ON s.action = a.action
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(a.scope -> 'entryIds') = 'array' THEN a.scope -> 'entryIds'
             ELSE '[]'::jsonb END) AS e(id)
      WHERE a.tenant_id = t AND a.resource_type = 'device_discard'
        AND a.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ON CONFLICT (tenant_id, discard_id, stage, entry_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.audit_event FORCE ROW LEVEL SECURITY;
-- backfill: end
