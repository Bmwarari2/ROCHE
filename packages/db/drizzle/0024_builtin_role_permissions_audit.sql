-- Audit for migration 0022 (built-in role permissions). 0022 added permissions to existing
-- tenants' built-in role copies as new role versions but wrote no audit event, and an applied
-- migration is never edited. This writes one audit_event per role copy that 0022 changed: actor
-- "system" (no tenant user), action platform.role.permissions_migrated, the role id, and the
-- permissions it gained, in that tenant's hash chain. A copy is recognised by its version history:
-- an earlier version written with no user (a migration) that lacked a permission 0022 adds,
-- while the current copy holds it. Idempotent: a role already audited is skipped.
-- packages/db/test/people-lifecycle.test.ts re-runs this file. FORCE is lifted on the role table
-- only to find the tenants (no tenant is set while migrating) and restored at the end.

ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT r.tenant_id, 'system', ARRAY['system'], 'platform.role.permissions_migrated',
        'success', 'role', r.id::text,
        jsonb_build_object(
          'migration', '0022_builtin_role_permissions',
          'roleKey', r.key,
          'added', to_jsonb(ARRAY(
            SELECT p FROM unnest(ARRAY['people.movement.record', 'people.property.manage',
              'safety.incident.read']) AS p
            WHERE p = ANY (r.permissions)
              AND NOT (v.data -> 'permissions') ? p
            ORDER BY p))),
        'Existing tenants'' built-in role copies gained the permissions their built-in definitions added (migration 0022)'
      FROM public.role r
      JOIN LATERAL (
        SELECT rv.data FROM public.record_version rv
        WHERE rv.tenant_id = r.tenant_id AND rv.table_name = 'role' AND rv.record_id = r.id
          AND rv.changed_by IS NULL
          AND EXISTS (
            SELECT 1 FROM unnest(ARRAY['people.movement.record', 'people.property.manage',
              'safety.incident.read']) AS p
            WHERE p = ANY (r.permissions) AND NOT (rv.data -> 'permissions') ? p)
        ORDER BY rv.record_version DESC
        LIMIT 1
      ) v ON true
      WHERE r.tenant_id = t AND r.is_builtin
        AND NOT EXISTS (
          SELECT 1 FROM public.audit_event e
          WHERE e.tenant_id = r.tenant_id AND e.action = 'platform.role.permissions_migrated'
            AND e.resource_type = 'role' AND e.resource_id = r.id::text
        );
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
