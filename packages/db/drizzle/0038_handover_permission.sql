-- Data migration: existing tenants' copies of the built-in roles gain the hand-over permission the
-- built-in definitions (packages/domain/src/platform/roles.ts) added with the hand-over of held
-- entries (care.md section 6, Device integrity part 6): care.held_entry.hand_over for the owner,
-- the Registered Manager, the deputy and the clinical lead, who may already delete held entries.
-- Each change is a new version of the role, made in that tenant's context and audited in the same
-- transaction (platform.role.permissions_migrated, naming what the copy gained). Idempotent.
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
        ('owner', ARRAY['care.held_entry.hand_over']),
        ('registered_manager', ARRAY['care.held_entry.hand_over']),
        ('deputy_manager', ARRAY['care.held_entry.hand_over']),
        ('clinical_lead', ARRAY['care.held_entry.hand_over'])
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
        jsonb_build_object('migration', '0038_handover_permission', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the hand-over permission their built-in definitions added (migration 0038)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
