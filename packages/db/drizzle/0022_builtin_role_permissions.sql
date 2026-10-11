-- Data migration: existing tenants' copies of the built-in roles gain the permissions the built-in
-- definitions (packages/domain/src/platform/roles.ts) have added since those copies were made:
-- people.movement.record and people.property.manage (people.md section 3: the owner, Registered
-- Manager, deputy, clinical lead and team leader) and safety.incident.read (slice 7: the roles
-- that work with people, the care coordinator and the quality lead). Tenants set up from now on
-- copy the definitions directly. Each change is a new version of the role (record_version keeps
-- the old one) made in that tenant's context. Idempotent: a copy that already holds the
-- permissions is left alone, so running it again changes nothing.
-- packages/db/test/people-lifecycle.test.ts checks this list against the domain.

ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    -- record_version rows are written by the versioning trigger under the tenant's policy.
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    UPDATE public.role r
      SET permissions = r.permissions
        || ARRAY(SELECT p FROM unnest(g.add) WITH ORDINALITY AS a(p, n)
                 WHERE p <> ALL (r.permissions) ORDER BY n)
      FROM (VALUES
        ('owner', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('registered_manager', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('deputy_manager', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('clinical_lead', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('team_leader', ARRAY['people.movement.record', 'people.property.manage', 'safety.incident.read']),
        ('care_worker', ARRAY['safety.incident.read']),
        ('agency_worker', ARRAY['safety.incident.read']),
        ('care_coordinator', ARRAY['safety.incident.read']),
        ('quality_lead', ARRAY['safety.incident.read'])
      ) AS g(key, add)
      WHERE r.tenant_id = t AND r.is_builtin AND r.key = g.key AND NOT (r.permissions @> g.add);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
