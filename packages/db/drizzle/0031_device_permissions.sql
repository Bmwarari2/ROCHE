-- Data migration: existing tenants' copies of the built-in roles gain the device permissions the
-- built-in definitions (packages/domain/src/platform/roles.ts) added with device revocation
-- (care.md section 6, Device integrity part 2): platform.device.read and platform.device.revoke
-- for the owner, the Registered Manager and the deputy. Tenants set up from now on copy the
-- definitions directly. Each change is a new version of the role (record_version keeps the old
-- one), made in that tenant's context, and audited in the same transaction: one
-- platform.role.permissions_migrated event per copy changed, naming what it gained. Idempotent: a
-- copy that already holds every permission is left alone and not audited again.
-- packages/db/test/device-integrity.test.ts re-runs this file and checks the list against the
-- domain.

ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['platform.device.read', 'platform.device.revoke']),
        ('registered_manager', ARRAY['platform.device.read', 'platform.device.revoke']),
        ('deputy_manager', ARRAY['platform.device.read', 'platform.device.revoke'])
      ),
      targets AS (
        SELECT r.id, r.tenant_id, r.key,
          ARRAY(SELECT p FROM unnest(g.add) WITH ORDINALITY AS a(p, n)
                WHERE p <> ALL (r.permissions) ORDER BY n) AS missing
        FROM public.role r JOIN grants g ON g.key = r.key
        WHERE r.tenant_id = t AND r.is_builtin AND NOT (r.permissions @> g.add)
      ),
      changed AS (
        UPDATE public.role r SET permissions = r.permissions || x.missing
          FROM targets x WHERE r.id = x.id
          RETURNING r.id
      )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT x.tenant_id, 'system', ARRAY['system'], 'platform.role.permissions_migrated',
        'success', 'role', x.id::text,
        jsonb_build_object('migration', '0031_device_permissions', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the device permissions their built-in definitions added (migration 0031)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
