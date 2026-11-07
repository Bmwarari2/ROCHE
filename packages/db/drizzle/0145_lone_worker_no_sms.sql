-- No SMS at launch (ADR-0132; H-09, H-105; HZ-125). No SMS gateway is contracted, so a text message
-- from a lone-worker alarm would go nowhere. From now on a route step cannot choose one while no
-- gateway is connected (checkRoute, sms_unavailable). This data migration removes 'sms' from the
-- saved lone-worker routes' steps and makes sure every step includes email: today email is the
-- only channel with a destination for staff (push has none until staff devices register, see
-- processDeliveries; a push-only step reached no one even before this change), so every step, and
-- so every route, alerts someone away from the app (checkRoute now asks the same of new routes). Each changed route is audited in the same transaction, and its managers (holders of
-- scheduling.lone_worker.manage) get a task to check it. Idempotent: a route whose every step has
-- email and none has 'sms' is untouched. No schema change.
ALTER TABLE public.escalation_chain NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.escalation_chain
           WHERE key = 'scheduling.lone_worker.alarm' ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH targets AS (
        SELECT c.id, c.tenant_id,
          (SELECT jsonb_agg(
             CASE WHEN s -> 'channels' ? 'sms' OR NOT (s -> 'channels' ? 'email') THEN
               jsonb_set(s, '{channels}', (
                 SELECT CASE
                   WHEN s -> 'channels' ? 'email' THEN coalesce(jsonb_agg(ch), '[]'::jsonb)
                   ELSE coalesce(jsonb_agg(ch), '[]'::jsonb) || '["email"]'::jsonb
                 END
                 FROM jsonb_array_elements_text(s -> 'channels') ch WHERE ch <> 'sms'))
             ELSE s END
             ORDER BY n)
           FROM jsonb_array_elements(c.steps) WITH ORDINALITY AS e(s, n)) AS steps,
          (SELECT count(*) FROM jsonb_array_elements(c.steps) s
            WHERE s -> 'channels' ? 'sms' OR NOT (s -> 'channels' ? 'email')) AS changed_steps
        FROM public.escalation_chain c
        WHERE c.tenant_id = t AND c.key = 'scheduling.lone_worker.alarm'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.steps) s
                      WHERE s -> 'channels' ? 'sms' OR NOT (s -> 'channels' ? 'email'))
      ),
      changed AS (
        UPDATE public.escalation_chain c SET steps = x.steps
          FROM targets x WHERE c.id = x.id
          RETURNING c.id
      ),
      told AS (
        INSERT INTO public.task (tenant_id, kind, title, required_permission, source_type,
            source_id, due_at)
          SELECT x.tenant_id, 'scheduling.lone_worker.route_sms_removed',
            'Check the lone-worker route: email was added and text messages removed, so every step reaches staff',
            'scheduling.lone_worker.manage', 'escalation_chain', x.id, now()
          FROM targets x JOIN changed c ON c.id = x.id
          RETURNING id
      )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT x.tenant_id, 'system', ARRAY['system'], 'scheduling.lone_worker.route_sms_removed',
        'success', 'escalation_chain', x.id::text,
        jsonb_build_object('migration', '0145_lone_worker_no_sms', 'steps', x.changed_steps),
        'The lone-worker route now reaches staff by email at every step, and text messages were removed: no SMS gateway or staff push at launch (ADR-0132, migration 0145)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE public.escalation_chain FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task FORCE ROW LEVEL SECURITY;
