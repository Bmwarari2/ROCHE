-- Audit for migration 0022 (built-in role permissions). 0022 added permissions to existing
-- tenants' built-in role copies as new role versions but wrote no audit event, and an applied
-- migration is never edited. This writes one audit_event per role copy that 0022 changed: actor
-- "system" (no tenant user), action platform.role.permissions_migrated, the role id, and the
-- permissions it gained, in that tenant's hash chain. 0022's own change is found in the copy's
-- version history: a version written with no user whose permissions lacked some of what 0022 adds
-- for that role key, followed by the state holding all of them. Only what 0022 adds for the key,
-- and was missing before that change, is credited, so a permission an administrator granted
-- earlier is never attributed to the migration. Idempotent: a role already audited is skipped.
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
            SELECT p FROM unnest(g.add) AS p
            WHERE NOT (v.before -> 'permissions') ? p AND (v.after -> 'permissions') ? p
            ORDER BY p))),
        'Existing tenants'' built-in role copies gained the permissions their built-in definitions added (migration 0022)'
      FROM public.role r
      -- What 0022 adds for each built-in key (kept in step with 0022 by the test).
      JOIN (VALUES
        ('owner', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('registered_manager', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('deputy_manager', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('clinical_lead', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('team_leader', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('care_worker', ARRAY['safety.incident.read']),
        ('agency_worker', ARRAY['safety.incident.read']),
        ('care_coordinator', ARRAY['safety.incident.read']),
        ('quality_lead', ARRAY['safety.incident.read'])
      ) AS g(key, add) ON g.key = r.key
      JOIN LATERAL (
        SELECT x.before, x.after FROM (
          SELECT rv.record_version, rv.data AS before,
            COALESCE(
              (SELECT nx.data FROM public.record_version nx
               WHERE nx.tenant_id = rv.tenant_id AND nx.table_name = 'role'
                 AND nx.record_id = rv.record_id AND nx.record_version = rv.record_version + 1),
              CASE WHEN r.version = rv.record_version + 1 THEN to_jsonb(r) END) AS after
          FROM public.record_version rv
          WHERE rv.tenant_id = r.tenant_id AND rv.table_name = 'role' AND rv.record_id = r.id
            AND rv.changed_by IS NULL
        ) x
        WHERE NOT ((x.before -> 'permissions') @> to_jsonb(g.add))
          AND (x.after -> 'permissions') @> to_jsonb(g.add)
        ORDER BY x.record_version DESC
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
