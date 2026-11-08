-- A death record's sensitive detail (slice 83 guides review; HZ-011, HZ-013): the clinician's
-- judgement on whether the death may be unnatural or suspicious, police references and the
-- mortality review are read only with safety.death_detail.read, where the record's location is,
-- not with safety.incident.read alone (agency workers, care coordinators and care workers hold
-- that). The whole death record and its steps are the detail, so the rows themselves are kept from
-- other readers; the worker and the migrator (no member: app.is_system()) still read them. Writes
-- already need safety.incident.manage in the API; the built-in roles that hold it hold this too.
CREATE POLICY death_detail_read ON public.death_record AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
     harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer
  USING (app.is_system() OR app.holds_permission_at('safety.death_detail.read', location_id));
--> statement-breakpoint
CREATE POLICY death_detail_read ON public.death_step AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
     harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer
  USING (app.is_system() OR EXISTS (SELECT 1 FROM public.death_record r
    WHERE r.tenant_id = death_step.tenant_id AND r.id = death_step.death_record_id));
--> statement-breakpoint
-- Data migration: existing tenants' copies of the built-in roles gain safety.death_detail.read, as
-- the built-in definitions (packages/domain/src/platform/roles.ts) now give it: the owner, the
-- Registered Manager, the deputy, the clinical lead, the team leader and the quality lead. Each
-- change is audited in the same transaction (platform.role.permissions_migrated), as migration
-- 0143 does. Idempotent.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['safety.death_detail.read']),
        ('registered_manager', ARRAY['safety.death_detail.read']),
        ('deputy_manager', ARRAY['safety.death_detail.read']),
        ('clinical_lead', ARRAY['safety.death_detail.read']),
        ('team_leader', ARRAY['safety.death_detail.read']),
        ('quality_lead', ARRAY['safety.death_detail.read'])
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
        jsonb_build_object('migration', '0159_death_detail_read', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the death record detail permission their built-in definitions added (migration 0159)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
