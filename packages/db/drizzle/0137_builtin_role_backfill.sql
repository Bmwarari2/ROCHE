-- Data migration: existing tenants' copies of the built-in roles gain the grants their built-in
-- definitions (packages/domain/src/platform/roles.ts) added since those tenants were created, and
-- tenants gain the built-in roles added since. Every grant and role below was added to the
-- definitions on `main` without a backfill (found by comparing BUILTIN_ROLES at every commit that
-- changed roles.ts or permissions.ts with the backfills in 0024, 0031, 0038, 0062, 0074 and 0093):
-- the staff file (slice 11, 0073) and the sponsor licence (slice 35, 0097) permissions, and the
-- speak-up (slice 24, 0086) and employee relations (slice 39, 0101) roles. The 0038 pattern: each
-- change is a new version of the role, made in that tenant's context and audited in the same
-- transaction (platform.role.permissions_migrated, naming what the copy gained). Idempotent.
-- packages/db/test/builtin-role-backfill.test.ts checks the definitions against the backfills.

ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['workforce.staff_file.read', 'workforce.staff_file.manage',
          'workforce.hr_document.read', 'workforce.dbs_risk_assessment.sign',
          'workforce.sponsor.manage', 'workforce.immigration.read', 'workforce.ldss.manage']),
        ('registered_manager', ARRAY['workforce.staff_file.read', 'workforce.staff_file.manage',
          'workforce.dbs_risk_assessment.sign', 'workforce.ldss.manage']),
        ('deputy_manager', ARRAY['workforce.staff_file.read', 'workforce.staff_file.manage',
          'workforce.ldss.manage']),
        ('hr', ARRAY['workforce.staff_file.read', 'workforce.staff_file.manage',
          'workforce.hr_document.read', 'workforce.sponsor.manage', 'workforce.immigration.read',
          'workforce.ldss.manage'])
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
        jsonb_build_object('migration', '0137_builtin_role_backfill', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the grants their built-in definitions added (migration 0137)'
      FROM targets x JOIN changed c ON c.id = x.id;

    -- Built-in roles added to the definitions after the tenant was created.
    WITH roles(key, name, description, permissions, scope_kind) AS (VALUES
        ('speak_up_guardian', 'Freedom to Speak Up lead',
          'Receives and manages speak-up concerns, named, confidential or anonymous.',
          ARRAY['safety.speak_up.manage'], 'tenant'),
        ('employee_relations_lead', 'Employee relations caseworker',
          'Opens grievance, disciplinary, capability, sickness and probation cases; reads only cases they are named on.',
          ARRAY['workforce.casework.manage'], 'none')
      ),
      created AS (
        INSERT INTO public.role (key, name, description, permissions, scope_kind, is_builtin)
          SELECT x.key, x.name, x.description, x.permissions, x.scope_kind::public.scope_kind, true
            FROM roles x
           WHERE NOT EXISTS (SELECT 1 FROM public.role r WHERE r.tenant_id = t AND r.key = x.key)
          RETURNING id, tenant_id, key, permissions
      )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT c.tenant_id, 'system', ARRAY['system'], 'platform.role.permissions_migrated',
        'success', 'role', c.id::text,
        jsonb_build_object('migration', '0137_builtin_role_backfill', 'roleKey', c.key,
          'created', true, 'added', to_jsonb(c.permissions)),
        'Existing tenants gained a built-in role their definitions added (migration 0137)'
      FROM created c;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
