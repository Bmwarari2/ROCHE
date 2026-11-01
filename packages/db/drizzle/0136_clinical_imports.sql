ALTER TABLE "import_batch" DROP CONSTRAINT "import_batch_record_type";--> statement-breakpoint
ALTER TABLE "care_plan" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "compliance_item" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_import_batch_fk" FOREIGN KEY ("tenant_id","import_batch_id") REFERENCES "public"."import_batch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_import_batch_fk" FOREIGN KEY ("tenant_id","import_batch_id") REFERENCES "public"."import_batch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_item" ADD CONSTRAINT "compliance_item_import_batch_fk" FOREIGN KEY ("tenant_id","import_batch_id") REFERENCES "public"."import_batch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_record_type" CHECK (record_type IN ('people', 'medicines', 'care_plans', 'staff_files'));--> statement-breakpoint

-- Importing medicines, care plans and staff files (slice 51; platform.md rules 27 to 31; PLAT-014,
-- WORK-013). Runs as harbour_owner.

-- An imported medicine is exactly one that carries its batch (as reconciliation_id does for a
-- reconciliation): origin 'import' if and only if import_batch_id is set.
ALTER TABLE public.medication ADD CONSTRAINT medication_import_link
  CHECK ((origin = 'import') = (import_batch_id IS NOT NULL));
--> statement-breakpoint

-- Who reaches an import (rule 27): platform.import.run and, per type, the permissions to create
-- and read its records, all across the organisation. Invoker rights, as migration 0088's.
CREATE OR REPLACE FUNCTION app.import_reachable(p_record_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_scope() = 'tenant' AND (
    app.current_user_id() IS NULL
    OR (app.holds_permission_at('platform.import.run', NULL)
        AND CASE p_record_type
              WHEN 'people' THEN app.holds_permission_at('people.person.create', NULL)
                AND app.holds_permission_at('people.person.read', NULL)
              WHEN 'medicines' THEN app.holds_permission_at('medicines.record.manage', NULL)
                AND app.holds_permission_at('people.person.read', NULL)
              WHEN 'care_plans' THEN app.holds_permission_at('care.plan.write', NULL)
                AND app.holds_permission_at('people.person.read', NULL)
              WHEN 'staff_files' THEN app.holds_permission_at('workforce.staff_file.manage', NULL)
              ELSE false
            END))
$$;
--> statement-breakpoint

-- A record is tied to the import batch that created it (#150 security review M1, as for people):
-- given a batch only as it is created, only while that batch is staged after its dry run and of
-- the record's own type, and never changed. A care plan only as a draft, a staff file check only
-- unverified. Invoker rights: under the application's row-level security only an importer of
-- that type sees the batch.
CREATE OR REPLACE FUNCTION app.record_import_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_type text := CASE TG_TABLE_NAME WHEN 'medication' THEN 'medicines'
                                    WHEN 'care_plan' THEN 'care_plans'
                                    ELSE 'staff_files' END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id THEN
      RAISE EXCEPTION 'import_batch_fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.import_batch_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.import_batch b
        WHERE b.id = NEW.import_batch_id AND b.tenant_id = NEW.tenant_id
          AND b.record_type = v_type AND b.status = 'staged' AND b.dry_run_at IS NOT NULL) THEN
    RAISE EXCEPTION 'import_batch_not_committing' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'care_plan' AND to_jsonb(NEW) ->> 'status' <> 'draft' THEN
    RAISE EXCEPTION 'imported_care_plan_is_a_draft' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'compliance_item' AND to_jsonb(NEW) ->> 'verified_by' IS NOT NULL THEN
    RAISE EXCEPTION 'imported_check_is_unverified' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medication', 'care_plan', 'compliance_item'] LOOP
    EXECUTE format('CREATE TRIGGER record_import_batch_guard BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.record_import_batch_guard()', t);
    EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, import_batch_id) '
      'WHERE import_batch_id IS NOT NULL', t || '_import_batch_idx', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Staff file checks are never deleted, except by an import's undo (rule 30): the undo function
-- runs as harbour_import_owner, the one role the trigger lets through.
DROP TRIGGER no_delete ON public.compliance_item;
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.compliance_item
  FOR EACH ROW WHEN (current_user <> 'harbour_import_owner')
  EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Undo (rules 14, 24, 28 to 30), by record type. Common to every type: a holder of the type's
-- import permissions across the organisation, in a request scoped to the whole organisation, once,
-- within `import.undo_window_days` of the commit (the rate table for the batch's home, failing
-- closed), whole or nothing (the counts must be exactly the commit's record ids).
-- - people: as migration 0088 (refused once a phone may hold them; open allergy status checks go
--   with them; only unchanged people nothing refers to).
-- - medicines: withdrawn, never deleted (the medicines record is append-only): only while every
--   one is still not yet checked, so none has been on a round (rule 28).
-- - care_plans: refused once a phone may hold them (drafts sync with the person's record, as
--   people's do); the drafts and their sections are removed only while each is an unchanged,
--   unpublished draft (version 1) with unchanged sections and nothing that refers to them
--   (an action, a change record).
-- - staff_files: removed only while every check is unchanged (version 1), unverified, unsigned,
--   with no HR-only document and no reminder task started or done; open reminder tasks go with
--   them.
-- Audited with the type and the count only.
GRANT CREATE ON SCHEMA app TO harbour_import_owner;
--> statement-breakpoint
SET ROLE harbour_import_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.undo_import_batch(p_batch uuid, p_request_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_commit uuid;
  v_ids uuid[];
  v_undone timestamptz;
  v_committed timestamptz;
  v_location uuid;
  v_type text;
  v_days numeric;
  v_removed integer;
  v_allowed boolean;
BEGIN
  SELECT b.location_id, b.record_type INTO v_location, v_type FROM public.import_batch b
   WHERE b.id = p_batch AND b.tenant_id = v_tenant;
  v_allowed := CASE v_type
      WHEN 'people' THEN app.holds_permission_at('people.person.create', NULL)
        AND app.holds_permission_at('people.person.read', NULL)
      WHEN 'medicines' THEN app.holds_permission_at('medicines.record.manage', NULL)
        AND app.holds_permission_at('people.person.read', NULL)
      WHEN 'care_plans' THEN app.holds_permission_at('care.plan.write', NULL)
        AND app.holds_permission_at('people.person.read', NULL)
      WHEN 'staff_files' THEN app.holds_permission_at('workforce.staff_file.manage', NULL)
      ELSE false
    END;
  IF v_me IS NULL OR app.current_scope() IS DISTINCT FROM 'tenant'
     OR NOT app.holds_permission_at('platform.import.run', NULL) THEN
    RAISE EXCEPTION 'missing_permission' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Another organisation's batch, or none: nothing to undo (as before slice 51).
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'nothing_to_undo' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(v_allowed, false) THEN
    RAISE EXCEPTION 'missing_permission' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.id, c.record_ids, c.undone_at, c.committed_at INTO v_commit, v_ids, v_undone, v_committed
    FROM public.import_commit c
   WHERE c.tenant_id = v_tenant AND c.batch_id = p_batch
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nothing_to_undo' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_undone IS NOT NULL THEN
    RAISE EXCEPTION 'already_undone' USING ERRCODE = 'check_violation';
  END IF;
  v_days := app.location_rate(v_location, 'import.undo_window_days', now());
  IF v_days IS NULL OR now() > v_committed + make_interval(days => v_days::integer) THEN
    RAISE EXCEPTION 'window_passed' USING ERRCODE = 'check_violation';
  END IF;
  IF v_type IN ('people', 'care_plans') AND EXISTS (
       SELECT 1 FROM public.audit_event a
        WHERE a.tenant_id = v_tenant AND a.action = 'sync.token.issue'
          AND a.occurred_at >= v_committed - interval '900 seconds'
          AND coalesce(a.scope ->> 'peopleLocations', '0') ~ '^[0-9]+$'
          AND (a.scope ->> 'peopleLocations')::integer > 0) THEN
    RAISE EXCEPTION 'sent_to_devices' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    IF v_type = 'people' THEN
      DELETE FROM public.task t
       WHERE t.tenant_id = v_tenant AND t.kind = 'people.allergy_status_check'
         AND t.source_type = 'import_batch' AND t.source_id = p_batch
         AND t.status = 'open' AND t.deleted_at IS NULL;
      DELETE FROM public.person p
       WHERE p.tenant_id = v_tenant AND p.import_batch_id = p_batch AND p.id = ANY (v_ids)
         AND p.version = 1 AND p.deleted_at IS NULL;
      GET DIAGNOSTICS v_removed = ROW_COUNT;
    ELSIF v_type = 'medicines' THEN
      UPDATE public.medication m
         SET state = 'withdrawn', withdrawn_by = v_me, withdrawn_at = now(),
             withdrawn_reason = 'The import that added it was undone'
       WHERE m.tenant_id = v_tenant AND m.import_batch_id = p_batch AND m.id = ANY (v_ids)
         AND m.state = 'not_yet_checked' AND m.check_at IS NULL AND m.withdrawn_at IS NULL
         AND m.deleted_at IS NULL;
      GET DIAGNOSTICS v_removed = ROW_COUNT;
    ELSIF v_type = 'care_plans' THEN
      IF EXISTS (SELECT 1 FROM public.care_plan_section s
                  WHERE s.tenant_id = v_tenant AND s.plan_id = ANY (v_ids)
                    AND (s.version <> 1 OR s.deleted_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'changed_since' USING ERRCODE = 'check_violation';
      END IF;
      IF (SELECT count(*) FROM public.care_plan p
           WHERE p.tenant_id = v_tenant AND p.import_batch_id = p_batch AND p.id = ANY (v_ids)
             AND p.status = 'draft' AND p.version = 1 AND p.deleted_at IS NULL)
         <> cardinality(v_ids) THEN
        RAISE EXCEPTION 'changed_since' USING ERRCODE = 'check_violation';
      END IF;
      DELETE FROM public.care_plan_section s
       WHERE s.tenant_id = v_tenant AND s.plan_id = ANY (v_ids);
      DELETE FROM public.care_plan p
       WHERE p.tenant_id = v_tenant AND p.import_batch_id = p_batch AND p.id = ANY (v_ids)
         AND p.status = 'draft' AND p.version = 1 AND p.deleted_at IS NULL;
      GET DIAGNOSTICS v_removed = ROW_COUNT;
    ELSIF v_type = 'staff_files' THEN
      IF EXISTS (SELECT 1 FROM public.task t
                  WHERE t.tenant_id = v_tenant AND t.source_type = 'compliance_item'
                    AND t.source_id = ANY (v_ids) AND t.status <> 'open')
         OR EXISTS (SELECT 1 FROM public.document d
                     WHERE d.tenant_id = v_tenant AND d.subject_type = 'compliance_item'
                       AND d.subject_id = ANY (v_ids)) THEN
        RAISE EXCEPTION 'referenced_since' USING ERRCODE = 'check_violation';
      END IF;
      DELETE FROM public.task t
       WHERE t.tenant_id = v_tenant AND t.source_type = 'compliance_item'
         AND t.source_id = ANY (v_ids) AND t.status = 'open';
      DELETE FROM public.compliance_item i
       WHERE i.tenant_id = v_tenant AND i.import_batch_id = p_batch AND i.id = ANY (v_ids)
         AND i.version = 1 AND i.verified_by IS NULL AND i.risk_assessment_signed_by IS NULL
         AND i.deleted_at IS NULL;
      GET DIAGNOSTICS v_removed = ROW_COUNT;
    ELSE
      RAISE EXCEPTION 'missing_permission' USING ERRCODE = 'insufficient_privilege';
    END IF;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'referenced_since' USING ERRCODE = 'check_violation';
  END;
  IF v_removed <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'changed_since' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.import_commit SET undone_at = now(), undone_by = v_me WHERE id = v_commit;
  UPDATE public.import_batch SET status = 'undone' WHERE id = p_batch AND tenant_id = v_tenant;
  INSERT INTO public.audit_event (tenant_id, actor_tenant_user_id, action, resource_type,
    resource_id, scope, request_id)
  VALUES (v_tenant, v_me, 'platform.import.undone', 'import_batch', p_batch::text,
    jsonb_build_object('records', v_removed, 'recordType', v_type), p_request_id);
  RETURN v_removed;
END
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_import_owner;
--> statement-breakpoint
-- What the undo needs for the new types, and nothing else.
GRANT SELECT (record_type) ON public.import_batch TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, import_batch_id, state, check_at, withdrawn_at, deleted_at, version,
  updated_at, person_id, medicine_id),
  UPDATE (state, withdrawn_by, withdrawn_at, withdrawn_reason, updated_at, updated_by)
  ON public.medication TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, import_batch_id, status, version, deleted_at), DELETE
  ON public.care_plan TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, plan_id, version, deleted_at), DELETE
  ON public.care_plan_section TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, import_batch_id, version, verified_by, risk_assessment_signed_by,
  deleted_at), DELETE ON public.compliance_item TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, subject_type, subject_id) ON public.document TO harbour_import_owner;
--> statement-breakpoint
-- A withdrawal keeps the version as it was (the history view; capture_version, invoker rights).
GRANT INSERT ON public.record_version TO harbour_import_owner;
--> statement-breakpoint

-- Sample data (migration 0069, HZ-072): the one list, redefined whole as the union of migration
-- 0099's (deaths, missing episodes, outbreak cases) and migration 0111's (medicines), children
-- before parents, so the highest migration holds the full list. Their grants are already made by
-- 0099 and 0111.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'medication_reconciliation_decision', 'medication_reconciliation_item',
    'medication_reconciliation_source', 'medication_schedule', 'medication',
    'medication_reconciliation',
    'death_step', 'missing_event', 'death_record', 'missing_episode', 'herbert_profile',
    'outbreak_case', 'dependency_assessment',
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'safeguarding_concern', 'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;
