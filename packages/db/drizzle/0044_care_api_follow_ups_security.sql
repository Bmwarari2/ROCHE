-- The care API follow-ups from the #15 reviews (care.md sections 5 and 6; hazards HZ-011, HZ-012,
-- HZ-014, HZ-019 and HZ-040): the ADR-0002 patterns for escalation_policy_link, discard_reason,
-- device_discard_record and entry_device_deletion_flag; the seeding of every organisation's
-- coded discard reasons; and the first rows of the deletion records and the entry flags from the
-- audit trail. Runs as harbour_owner.

-- Row-level security on the four new tables, forced, with the tenant isolation policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'escalation_policy_link', 'discard_reason', 'device_discard_record', 'entry_device_deletion_flag'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Escalation policy links (care.md section 5): configuration every member reads, beside every
-- validated-tool result. Only tenant-wide roles write the organisation's links; a location role
-- writes only its own locations' (the API checks quality.policy.manage first).
CREATE POLICY escalation_policy_link_write ON public.escalation_policy_link AS RESTRICTIVE
  FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant'
    OR (location_id IS NOT NULL AND location_id = ANY (app.current_location_ids())));
--> statement-breakpoint
CREATE POLICY escalation_policy_link_change ON public.escalation_policy_link AS RESTRICTIVE
  FOR UPDATE TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant'
    OR (location_id IS NOT NULL AND location_id = ANY (app.current_location_ids())))
  WITH CHECK (app.current_scope() = 'tenant'
    OR (location_id IS NOT NULL AND location_id = ANY (app.current_location_ids())));
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.escalation_policy_link
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.escalation_policy_link
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.escalation_policy_link TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.escalation_policy_link FROM harbour_app;
--> statement-breakpoint

-- Coded discard reasons (care.md section 6, Device integrity part 8): every member reads the list
-- (the phone offers it); only tenant-wide roles change it (platform.tenant.manage).
CREATE POLICY discard_reason_write ON public.discard_reason AS RESTRICTIVE
  FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE POLICY discard_reason_change ON public.discard_reason AS RESTRICTIVE
  FOR UPDATE TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant')
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.discard_reason
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.discard_reason
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.discard_reason TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.discard_reason FROM harbour_app;
--> statement-breakpoint

-- Deletion records, one row per stage (care.md section 6, Device integrity part 3): read like the
-- deletion lists (a member their own deletions, as owner or sender; tenant-wide roles the
-- organisation's; a location role those of owners with a live, undeleted role assignment at one
-- of its locations). Written only in the system's view, after the API's checks, so the replay
-- guard sees every stage whoever sends the next one.
CREATE POLICY device_discard_record_scope ON public.device_discard_record AS RESTRICTIVE
  FOR SELECT TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant'
    OR owner_tenant_user_id = app.current_user_id()
    OR sender_tenant_user_id = app.current_user_id()
    OR (app.current_scope() = 'locations' AND EXISTS (
      SELECT 1 FROM public.role_assignment ra
      WHERE ra.tenant_id = device_discard_record.tenant_id
        AND ra.tenant_user_id = device_discard_record.owner_tenant_user_id
        AND ra.location_id = ANY (app.current_location_ids())
        AND ra.deleted_at IS NULL AND ra.valid_from <= now()
        AND (ra.valid_to IS NULL OR ra.valid_to > now()))));
--> statement-breakpoint
CREATE POLICY device_discard_record_system_insert ON public.device_discard_record AS RESTRICTIVE
  FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.device_discard_record
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.device_discard_record
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.device_discard_record TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.device_discard_record FROM harbour_app;
--> statement-breakpoint

-- The server's flag on an entry its device recorded deleting (Device integrity part 3): read like
-- the entry (the person's scope, assignments and break-glass); written only in the system's view,
-- because the uploader may not see every location's review tasks.
CREATE POLICY entry_device_deletion_flag_scope ON public.entry_device_deletion_flag AS RESTRICTIVE
  FOR SELECT TO harbour_app, harbour_owner
  USING (app.person_visible(person_id));
--> statement-breakpoint
CREATE POLICY entry_device_deletion_flag_system_insert ON public.entry_device_deletion_flag
  AS RESTRICTIVE FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.entry_device_deletion_flag
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.entry_device_deletion_flag
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.entry_device_deletion_flag TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.entry_device_deletion_flag FROM harbour_app;
--> statement-breakpoint

-- Every organisation starts with the phone's five coded reasons (DEFAULT_DISCARD_REASONS in
-- packages/domain; packages/db/test keeps the two in step). A trigger on tenant seeds them in the
-- new tenant's view whoever creates it (the operator console, the demo seed, tests), restoring
-- the caller's settings afterwards.
CREATE OR REPLACE FUNCTION app.seed_discard_reasons(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prev_tenant text := current_setting('app.tenant_id', true);
  prev_scope text := current_setting('app.scope', true);
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  PERFORM set_config('app.scope', 'tenant', true);
  INSERT INTO public.discard_reason (tenant_id, code, label, sort_order, seeded)
  VALUES
    (p_tenant, 'recorded_elsewhere', 'Recorded again elsewhere, for example on paper', 10, true),
    (p_tenant, 'entered_in_error', 'Entered in error', 20, true),
    (p_tenant, 'staff_left', 'The member of staff who wrote them has left', 30, true),
    (p_tenant, 'nurse_in_charge_informed',
      'The nurse in charge knows and will make sure the care is recorded', 40, true),
    (p_tenant, 'other', 'Other', 90, true)
  ON CONFLICT (tenant_id, code) DO NOTHING;
  PERFORM set_config('app.tenant_id', coalesce(prev_tenant, ''), true);
  PERFORM set_config('app.scope', coalesce(prev_scope, ''), true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.seed_discard_reasons(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.seed_tenant_discard_reasons() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM app.seed_discard_reasons(NEW.id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.seed_tenant_discard_reasons() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER seed_discard_reasons AFTER INSERT ON public.tenant
  FOR EACH ROW EXECUTE FUNCTION app.seed_tenant_discard_reasons();
--> statement-breakpoint

-- The first rows, in each existing tenant's view: the seeded reasons; one deletion record row per
-- stage already in the audit trail (its earliest event, with staff ids kept only when they are
-- staff here); and one flag per entry the audit trail flagged after or before a deletion. FORCE is
-- lifted on tenant only to list the tenants and restored at the end. Idempotent.
-- backfill: begin
ALTER TABLE public.tenant NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM public.tenant ORDER BY id LOOP
    PERFORM app.seed_discard_reasons(t);
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);

    INSERT INTO public.device_discard_record (tenant_id, discard_id, stage, kind, reason_code,
        owner_tenant_user_id, deleted_by_tenant_user_id, sender_tenant_user_id, device_id,
        entry_count, discarded_at, recorded_at, created_at)
      SELECT DISTINCT ON (a.resource_id, s.stage)
        a.tenant_id, lower(a.resource_id)::uuid, s.stage, a.scope ->> 'kind',
        a.scope ->> 'reasonCode',
        CASE WHEN EXISTS (SELECT 1 FROM public.tenant_user u WHERE u.tenant_id = a.tenant_id
                            AND u.id::text = lower(a.scope ->> 'ownerTenantUserId'))
             THEN lower(a.scope ->> 'ownerTenantUserId')::uuid END,
        CASE WHEN EXISTS (SELECT 1 FROM public.tenant_user u WHERE u.tenant_id = a.tenant_id
                            AND u.id::text = lower(a.scope ->> 'deletedByTenantUserId'))
             THEN lower(a.scope ->> 'deletedByTenantUserId')::uuid END,
        a.actor_tenant_user_id,
        CASE
          WHEN a.scope ->> 'heldOnDeviceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN lower(a.scope ->> 'heldOnDeviceId')::uuid
          WHEN a.device_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN lower(a.device_id)::uuid
        END,
        CASE WHEN jsonb_typeof(a.scope -> 'count') = 'number'
               AND (a.scope ->> 'count')::numeric BETWEEN 0 AND 100000
             THEN (a.scope ->> 'count')::numeric::integer END,
        CASE WHEN a.scope ->> 'discardedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
             THEN (a.scope ->> 'discardedAt')::timestamptz ELSE a.occurred_at END,
        a.occurred_at, now()
      FROM public.audit_event a
      JOIN (VALUES ('sync.entries.discard_requested', 'requested'),
                   ('sync.entries.discarded', 'deleted'),
                   ('sync.entries.discard_failed', 'failed')) AS s(action, stage)
        ON s.action = a.action
      WHERE a.tenant_id = t AND a.resource_type = 'device_discard'
        AND a.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND a.scope ->> 'kind' IN ('held_deleted', 'signed_out_with_unsent', 'refused_removed')
        AND EXISTS (SELECT 1 FROM public.discard_reason r
                    WHERE r.tenant_id = a.tenant_id AND r.code = a.scope ->> 'reasonCode')
        AND EXISTS (SELECT 1 FROM public.tenant_user u
                    WHERE u.tenant_id = a.tenant_id AND u.id = a.actor_tenant_user_id)
      ORDER BY a.resource_id, s.stage, a.seq
      ON CONFLICT (tenant_id, discard_id, stage) DO NOTHING;

    INSERT INTO public.entry_device_deletion_flag (tenant_id, record_table, entry_id, person_id,
        location_id, flag, discard_id, owner_tenant_user_id, review_task_id, flagged_at,
        created_at)
      WITH flagged AS (
        SELECT a.seq, a.occurred_at, a.resource_type,
          lower(a.resource_id)::uuid AS entry_id,
          lower(a.scope ->> 'discardId')::uuid AS discard_id,
          CASE WHEN a.scope ->> 'taskId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN lower(a.scope ->> 'taskId')::uuid END AS task_id,
          CASE a.action WHEN 'sync.entry.after_discard' THEN 'uploaded_after_deletion'
                        ELSE 'deleted_after_upload' END AS flag
        FROM public.audit_event a
        WHERE a.tenant_id = t
          AND a.action IN ('sync.entry.after_discard', 'sync.entry.before_discard')
          AND a.resource_type IN ('care_note', 'observation', 'body_map_mark', 'activity_record',
                                  'visit_log', 'assessment')
          AND a.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND a.scope ->> 'discardId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ),
      entries AS (
        SELECT 'care_note' AS record_table, id, person_id, location_id, created_by FROM public.care_note
        UNION ALL SELECT 'observation', id, person_id, location_id, created_by FROM public.observation
        UNION ALL SELECT 'body_map_mark', id, person_id, location_id, created_by FROM public.body_map_mark
        UNION ALL SELECT 'activity_record', id, person_id, location_id, created_by FROM public.activity_record
        UNION ALL SELECT 'visit_log', id, person_id, location_id, created_by FROM public.visit_log
        UNION ALL SELECT 'assessment', id, person_id, location_id, created_by FROM public.assessment
      )
      SELECT DISTINCT ON (f.entry_id)
        t, f.resource_type, f.entry_id, e.person_id, e.location_id, f.flag, f.discard_id,
        e.created_by,
        CASE WHEN EXISTS (SELECT 1 FROM public.task k WHERE k.tenant_id = t AND k.id = f.task_id)
             THEN f.task_id END,
        f.occurred_at, now()
      FROM flagged f
      JOIN entries e ON e.record_table = f.resource_type AND e.id = f.entry_id
      WHERE e.created_by IS NOT NULL
      ORDER BY f.entry_id, f.seq
      ON CONFLICT (tenant_id, entry_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.tenant FORCE ROW LEVEL SECURITY;
-- backfill: end
