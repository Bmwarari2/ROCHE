-- One open sync task per source (care.md section 6, Device integrity part 4; hazards HZ-008 and
-- HZ-040), before 0035's partial unique index can be built:
-- 1. any duplicate an earlier race left open (two open tasks of the same kind, source, location and
--    assignee for the device-hold, flagged-entry and refused-entry review kinds) is closed, the
--    oldest staying open, as a cancellation with a reason, audited as the system;
-- 2. open flagged-entry tasks get their owner and count in task.details, taken from their audit
--    events, so the owner's cap reads the task itself from now on.
-- Run in each tenant's view; FORCE is lifted on the task table only to find the tenants (no tenant
-- is set while migrating) and restored at the end. Idempotent.

ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.task
           WHERE kind IN ('sync.device_hold', 'sync.entry_reported_deleted',
                          'sync.entry_deleted_after_upload', 'care.refused_entry_review')
           ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH ranked AS (
        SELECT id, row_number() OVER (
                 PARTITION BY kind, source_type, source_id,
                   coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   coalesce(assignee_tenant_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
                 ORDER BY created_at, id) AS n,
               first_value(id) OVER (
                 PARTITION BY kind, source_type, source_id,
                   coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   coalesce(assignee_tenant_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
                 ORDER BY created_at, id) AS kept
        FROM public.task
        WHERE tenant_id = t AND deleted_at IS NULL AND status IN ('open', 'in_progress')
          AND kind IN ('sync.device_hold', 'sync.entry_reported_deleted',
                       'sync.entry_deleted_after_upload', 'care.refused_entry_review')
      ),
      closed AS (
        UPDATE public.task k
          SET status = 'cancelled',
              status_reason = 'Closed as a duplicate of an open task for the same source (migration 0034).'
          FROM ranked r
          WHERE k.id = r.id AND r.n > 1
          RETURNING k.id, k.tenant_id, r.kept
      )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope)
      SELECT c.tenant_id, 'system', ARRAY['system'], 'platform.task.duplicate_closed', 'success',
        'task', c.id::text,
        jsonb_build_object('migration', '0034_sync_task_dedupe', 'keptTaskId', c.kept)
      FROM closed c;

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
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.task FORCE ROW LEVEL SECURITY;
