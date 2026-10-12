-- One open sync task per source (care.md section 6, Device integrity part 4; hazards HZ-008 and
-- HZ-040), before 0035's partial unique index can be built:
-- 1. open flagged-entry tasks get their owner and count in task.details, taken from their audit
--    events, so the owner's cap reads the task itself from now on;
-- 2. where an earlier race left duplicates (two open tasks of the same kind, source, location and
--    assignee for the device-hold, flagged-entry and refused-entry review kinds), the oldest stays
--    open and takes over what the others carried (#25 review round 2, low): the earliest due time,
--    urgent if any was, in progress if any was, the flagged entries' count and the entries listed
--    in their details (up to 50, as the API keeps them); the others are closed as a cancellation
--    with a reason, audited as the system.
-- Run in each tenant's view; FORCE is lifted on the task table only to find the tenants (no tenant
-- is set while migrating) and restored at the end. Idempotent.

ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  t uuid;
  g record;
  merged jsonb;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.task
           WHERE kind IN ('sync.device_hold', 'sync.entry_reported_deleted',
                          'sync.entry_deleted_after_upload', 'care.refused_entry_review')
           ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);

    UPDATE public.task k
      SET details = jsonb_build_object(
            'ownerTenantUserId', (
              SELECT a.scope ->> 'ownerTenantUserId' FROM public.audit_event a
              WHERE a.tenant_id = k.tenant_id AND a.resource_type = 'task'
                AND a.resource_id = k.id::text AND a.action = 'sync.entry_flag.raised'
              ORDER BY a.seq LIMIT 1),
            'entryCount', coalesce((
              SELECT (a.scope ->> 'count')::int FROM public.audit_event a
              WHERE a.tenant_id = k.tenant_id AND a.resource_type = 'task'
                AND a.resource_id = k.id::text
                AND a.action IN ('sync.entry_flag.raised', 'sync.entry_flag.added')
              ORDER BY a.seq DESC LIMIT 1), 0))
      WHERE k.tenant_id = t AND k.deleted_at IS NULL AND k.details IS NULL
        AND k.status IN ('open', 'in_progress') AND k.source_type = 'device_discard'
        AND k.kind IN ('sync.entry_reported_deleted', 'sync.entry_deleted_after_upload');

    FOR g IN
      SELECT r.kept, array_agg(r.id ORDER BY r.n) AS ids
      FROM (
        SELECT id,
               row_number() OVER w AS n,
               first_value(id) OVER w AS kept
        FROM public.task
        WHERE tenant_id = t AND deleted_at IS NULL AND status IN ('open', 'in_progress')
          AND kind IN ('sync.device_hold', 'sync.entry_reported_deleted',
                       'sync.entry_deleted_after_upload', 'care.refused_entry_review')
        WINDOW w AS (
          PARTITION BY kind, source_type, source_id,
            coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
            coalesce(assignee_tenant_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY created_at, id)
      ) r
      GROUP BY r.kept
      HAVING count(*) > 1
    LOOP
      SELECT coalesce(jsonb_agg(x.value ORDER BY x.task_n, x.entry_n), '[]'::jsonb) INTO merged
      FROM (
        SELECT e.value, array_position(g.ids, d.id) AS task_n, e.n AS entry_n
        FROM public.task d,
             jsonb_array_elements(CASE WHEN jsonb_typeof(d.details -> 'entries') = 'array'
                                       THEN d.details -> 'entries' ELSE '[]'::jsonb END)
               WITH ORDINALITY AS e(value, n)
        WHERE d.id = ANY (g.ids)
        ORDER BY task_n, entry_n
        LIMIT 50
      ) x;

      UPDATE public.task k
        SET due_at = (SELECT min(d.due_at) FROM public.task d WHERE d.id = ANY (g.ids)),
            priority = CASE
              WHEN EXISTS (SELECT 1 FROM public.task d WHERE d.id = ANY (g.ids)
                           AND d.priority = 'urgent') THEN 'urgent'
              ELSE k.priority END,
            status = CASE
              WHEN EXISTS (SELECT 1 FROM public.task d WHERE d.id = ANY (g.ids)
                           AND d.status = 'in_progress') THEN 'in_progress'
              ELSE k.status END,
            details = CASE
              WHEN k.details IS NULL AND jsonb_array_length(merged) = 0
                   AND k.kind NOT IN ('sync.entry_reported_deleted',
                                      'sync.entry_deleted_after_upload') THEN NULL
              ELSE coalesce(k.details, '{}'::jsonb)
                || CASE WHEN k.kind IN ('sync.entry_reported_deleted',
                                        'sync.entry_deleted_after_upload')
                     THEN jsonb_build_object('entryCount', (
                       SELECT coalesce(sum(coalesce((d.details ->> 'entryCount')::int, 0)), 0)
                       FROM public.task d WHERE d.id = ANY (g.ids)))
                     ELSE '{}'::jsonb END
                || CASE WHEN jsonb_array_length(merged) > 0
                     THEN jsonb_build_object('entries', merged) ELSE '{}'::jsonb END
              END
        WHERE k.id = g.kept;

      WITH closed AS (
        UPDATE public.task k
          SET status = 'cancelled',
              status_reason = 'Closed as a duplicate of an open task for the same source (migration 0034).'
          WHERE k.id = ANY (g.ids[2:])
          RETURNING k.id, k.tenant_id
      )
      INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
          outcome, resource_type, resource_id, scope)
        SELECT c.tenant_id, 'system', ARRAY['system'], 'platform.task.duplicate_closed', 'success',
          'task', c.id::text,
          jsonb_build_object('migration', '0034_sync_task_dedupe', 'keptTaskId', g.kept)
        FROM closed c;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.task FORCE ROW LEVEL SECURITY;
