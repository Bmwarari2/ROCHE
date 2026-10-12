-- Device binding (care.md section 6, Device integrity part 1; hazards HZ-011 and HZ-040): the
-- ADR-0002 patterns for device_binding, and its first rows from the audit trail. Runs as
-- harbour_owner.

ALTER TABLE public.device_binding ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.device_binding FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.device_binding AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- A member reads their own devices; tenant-wide roles read the organisation's, and a location role
-- the bindings of staff with a role assignment at one of its locations, as the API narrows them
-- (#25 review round 2, low). Writing is the system's alone: the sync token and device report
-- routes bind in the organisation's view, and a revocation is written there after the API has
-- checked the manager (HZ-011).
CREATE POLICY device_binding_scope ON public.device_binding AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant'
    OR tenant_user_id = app.current_user_id()
    OR (app.current_scope() = 'locations' AND EXISTS (
      SELECT 1 FROM public.role_assignment ra
      WHERE ra.tenant_id = device_binding.tenant_id
        AND ra.tenant_user_id = device_binding.tenant_user_id
        AND ra.location_id = ANY (app.current_location_ids()))));
--> statement-breakpoint
CREATE POLICY device_binding_system_insert ON public.device_binding AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE POLICY device_binding_system_update ON public.device_binding AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant')
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint

-- A binding is never moved to another device or member, a sighting never goes back in time, and a
-- revocation is never undone (a device revoked by mistake is replaced by a new database, so a new
-- device id).
CREATE OR REPLACE FUNCTION app.device_binding_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.tenant_user_id IS DISTINCT FROM OLD.tenant_user_id
     OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at THEN
    RAISE EXCEPTION 'A device binding keeps its device, member and first sighting'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    NEW.last_seen_at := OLD.last_seen_at;
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason) THEN
    RAISE EXCEPTION 'A revoked device stays revoked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER device_binding_guard BEFORE UPDATE ON public.device_binding
  FOR EACH ROW EXECUTE FUNCTION app.device_binding_guard();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.device_binding TO harbour_app;
--> statement-breakpoint

-- The first rows: every member who already has an event from a device whose resource is that
-- device (a sync token issued to it, a report sent from it), first and last seen as the audit trail
-- says, so hold reports keep their bound owners and start floors (security review round 7, M1).
-- Run in each tenant's view (row-level security is forced for the owner too); FORCE is lifted on
-- the audit trail only to find the tenants (no tenant is set while migrating) and restored at the
-- end. Idempotent.
-- backfill: begin
ALTER TABLE public.audit_event NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.audit_event
           WHERE resource_type = 'device' AND tenant_id IS NOT NULL ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    INSERT INTO public.device_binding (tenant_id, device_id, tenant_user_id, first_seen_at,
        last_seen_at, created_at)
      SELECT a.tenant_id, lower(a.resource_id)::uuid, a.actor_tenant_user_id,
        min(a.occurred_at), max(a.occurred_at), now()
      FROM public.audit_event a
      WHERE a.tenant_id = t AND a.resource_type = 'device' AND a.actor_tenant_user_id IS NOT NULL
        AND a.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND EXISTS (SELECT 1 FROM public.tenant_user u
                    WHERE u.tenant_id = a.tenant_id AND u.id = a.actor_tenant_user_id)
      GROUP BY a.tenant_id, lower(a.resource_id), a.actor_tenant_user_id
      ON CONFLICT (tenant_id, device_id, tenant_user_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.audit_event FORCE ROW LEVEL SECURITY;
-- backfill: end
