CREATE TABLE "sample_batch" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"loaded_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"people" integer NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "sample_batch_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "sample_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "sample_batch" ADD CONSTRAINT "sample_batch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_batch" ADD CONSTRAINT "sample_batch_loaded_by_fk" FOREIGN KEY ("tenant_id","loaded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_batch" ADD CONSTRAINT "sample_batch_removed_by_fk" FOREIGN KEY ("tenant_id","removed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_sample_batch_fk" FOREIGN KEY ("tenant_id","sample_batch_id") REFERENCES "public"."sample_batch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_sample" CHECK (is_sample = (sample_batch_id IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "sample_batch_one_open_key" ON "sample_batch" USING btree ("tenant_id") WHERE removed_at IS NULL;--> statement-breakpoint

-- Sample data mode (platform-completions.md rules 29 to 32; HZ-072). A batch is loaded by a
-- holder of platform.onboarding.manage, in their own name, and removed only by
-- app.remove_sample_batch; the application never updates or deletes a batch or a person.
ALTER TABLE public.sample_batch ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sample_batch FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sample_batch AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY sample_batch_load ON public.sample_batch AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (loaded_by = app.current_user_id() AND removed_at IS NULL AND removed_by IS NULL
    AND app.holds_role_permission_somewhere('platform.onboarding.manage'));
--> statement-breakpoint
GRANT SELECT, INSERT ON public.sample_batch TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.sample_batch FROM harbour_app;
--> statement-breakpoint

-- Whether the organisation has sample data in place (an open batch) and whether it has ever had a
-- real person (soft-deleted ones too: they are still the organisation's records), whatever the
-- caller's scope. The guards need the whole organisation, so this reads as its own NOLOGIN owner;
-- it says only yes or no, never how many.
CREATE OR REPLACE FUNCTION app.sample_people() RETURNS TABLE (has_sample boolean, has_real boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.sample_batch b
                  WHERE b.tenant_id = app.current_tenant_id() AND b.removed_at IS NULL),
         EXISTS (SELECT 1 FROM public.person p
                  WHERE p.tenant_id = app.current_tenant_id() AND NOT p.is_sample)
$$;
--> statement-breakpoint

-- Real and sample people never share a list (rule 30): a real person waits until the sample data
-- has gone, by every creation path; a sample person is loaded only into an open batch and only
-- while the organisation has no real person; and a person never changes between the two. It runs
-- as harbour_sample_owner so that every role that writes people (the API, the seed, the worker) is
-- guarded alike; no role may call it directly.
--
-- The advisory lock serialises the check per organisation. That is enough only because each
-- statement takes a new snapshot after the lock is granted (READ COMMITTED), or because a
-- conflicting pair is aborted (SERIALIZABLE). Under REPEATABLE READ the check would read a
-- snapshot from before the lock, so the guard refuses to run there.
CREATE OR REPLACE FUNCTION app.person_sample_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_sample boolean; v_real boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.is_sample, NEW.sample_batch_id) IS DISTINCT FROM (OLD.is_sample, OLD.sample_batch_id) THEN
      RAISE EXCEPTION 'sample_flag_fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'person_sample_guard needs READ COMMITTED or SERIALIZABLE'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('harbour.sample_people'), hashtext(NEW.tenant_id::text));
  SELECT s.has_sample, s.has_real INTO v_sample, v_real FROM app.sample_people() s;
  IF NEW.is_sample THEN
    IF v_real THEN
      RAISE EXCEPTION 'real_people_exist' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sample_batch b
                    WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.sample_batch_id
                      AND b.removed_at IS NULL) THEN
      RAISE EXCEPTION 'nothing_to_remove' USING ERRCODE = 'check_violation',
        DETAIL = 'A sample person joins only a batch that is still in place.';
    END IF;
  ELSIF v_sample THEN
    RAISE EXCEPTION 'remove_sample_data_first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER person_sample_guard BEFORE INSERT OR UPDATE ON public.person
  FOR EACH ROW EXECUTE FUNCTION app.person_sample_guard();
--> statement-breakpoint

-- Append-only and no-delete tables refuse every change (defence in depth on top of the grants).
-- The one exception is removing a sample batch: inside app.remove_sample_batch, which runs as
-- harbour_sample_owner and marks the transaction, a row may be deleted. That role holds DELETE
-- only on the records about people listed there, never on audit_event or record_version.
CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' AND current_user = 'harbour_sample_owner'
     AND current_setting('app.sample_removal', true) = 'on'
     AND TG_TABLE_NAME NOT IN ('audit_event', 'record_version') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed; record a correction instead', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

-- Removes a whole batch or nothing (rule 32): a holder of platform.onboarding.manage, a batch of
-- this organisation still in place, none of its people under an active legal hold. The people are
-- invented, so everything recorded about them while practising goes too: the tables below, children
-- before parents (worked out from the foreign keys), each limited to this organisation and the
-- batch's people, hard deleted. A released legal hold goes with them. Anything else that still
-- refers to them (an outage, a downtime pack) stops the removal. The batch row records the removal
-- and the organisation's audit trail keeps it, with counts per table (ids and counts only); audit
-- events about the sample people stay.
CREATE OR REPLACE FUNCTION app.remove_sample_batch(p_batch uuid, p_request_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_people uuid[];
  v_table text;
  v_count integer;
  v_records jsonb := '{}'::jsonb;
  v_removed integer;
BEGIN
  IF v_me IS NULL OR NOT app.holds_role_permission_somewhere('platform.onboarding.manage') THEN
    RAISE EXCEPTION 'missing_permission' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM public.sample_batch b
    WHERE b.id = p_batch AND b.tenant_id = v_tenant AND b.removed_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nothing_to_remove' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT coalesce(array_agg(p.id), '{}') INTO v_people FROM public.person p
   WHERE p.tenant_id = v_tenant AND p.sample_batch_id = p_batch AND p.is_sample;
  IF EXISTS (SELECT 1 FROM public.legal_hold h
              WHERE h.tenant_id = v_tenant AND h.person_id = ANY (v_people)
                AND h.released_at IS NULL) THEN
    RAISE EXCEPTION 'held' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.sample_removal', 'on', true);
  BEGIN
    -- A delivery belongs to its notification, which names the person.
    DELETE FROM public.notification_delivery d
     USING public.notification n
     WHERE d.tenant_id = v_tenant AND n.tenant_id = v_tenant AND d.notification_id = n.id
       AND n.person_id = ANY (v_people);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      v_records := v_records || jsonb_build_object('notification_delivery', v_count);
    END IF;
    FOREACH v_table IN ARRAY ARRAY[
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
    ] LOOP
      CONTINUE WHEN v_table = 'notification_delivery';
      IF v_table = 'document' THEN
        -- A person's photo is one of their documents: let go of it first.
        UPDATE public.person p SET photo_document_id = NULL
         WHERE p.tenant_id = v_tenant AND p.id = ANY (v_people) AND p.photo_document_id IS NOT NULL;
      END IF;
      EXECUTE format('DELETE FROM public.%I WHERE tenant_id = $1 AND person_id = ANY ($2)', v_table)
        USING v_tenant, v_people;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count > 0 THEN
        v_records := v_records || jsonb_build_object(v_table, v_count);
      END IF;
    END LOOP;
    DELETE FROM public.person p
     WHERE p.tenant_id = v_tenant AND p.id = ANY (v_people) AND p.is_sample;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'referenced_by_other_records' USING ERRCODE = 'check_violation';
  END;
  PERFORM set_config('app.sample_removal', '', true);
  UPDATE public.sample_batch SET removed_at = now(), removed_by = v_me WHERE id = p_batch;
  INSERT INTO public.audit_event (tenant_id, actor_tenant_user_id, action, resource_type,
    resource_id, scope, request_id)
  VALUES (v_tenant, v_me, 'platform.onboarding.sample_removed', 'sample_batch', p_batch::text,
    jsonb_build_object('people', v_removed, 'records', v_records), p_request_id);
  RETURN v_removed;
END
$$;
--> statement-breakpoint

-- What harbour_sample_owner's functions need, and nothing else. Execute rights are set before
-- the owner changes (ADR-0002).
GRANT USAGE ON SCHEMA public, app TO harbour_sample_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, is_sample, sample_batch_id, photo_document_id),
  UPDATE (photo_document_id), DELETE ON public.person TO harbour_sample_owner;
--> statement-breakpoint
GRANT INSERT ON public.record_version TO harbour_sample_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, removed_at), UPDATE (removed_at, removed_by)
  ON public.sample_batch TO harbour_sample_owner;
--> statement-breakpoint
GRANT SELECT, DELETE ON
  public.about_me, public.about_me_share_link, public.activity_record, public.admission_condition,
  public.advance_care_record, public.allergy, public.assessment, public.bed_occupancy,
  public.body_map_mark, public.break_glass_event, public.candour_record, public.care_note,
  public.care_plan_action, public.care_plan_change, public.consent_record,
  public.document_signature, public.dols_legal_change_review, public.entry_device_deletion_flag,
  public.exit_checklist_item, public.family_portal_user, public.feed_item_withdrawal,
  public.feed_view, public.handover_note, public.incident_person, public.key_issue,
  public.legal_hold, public.letter, public.notification_delivery, public.observation,
  public.person_assignment, public.person_care_profile, public.property_item,
  public.refused_entry, public.sharing_decision_suspension, public.statutory_notification,
  public.visit_log, public.welcome_checklist_item, public.workflow_transition,
  public.care_plan_section, public.dols_authorisation, public.exit_record, public.feed_item,
  public.handover_item, public.hospital_transfer, public.notification, public.placement,
  public.review_record, public.risk_assessment, public.sharing_decision, public.task,
  public.admission_decision, public.best_interests_decision, public.care_plan, public.document,
  public.task_series, public.workflow_instance, public.capacity_assessment, public.contact,
  public.pre_admission_assessment
  TO harbour_sample_owner;
--> statement-breakpoint
GRANT SELECT ON public.role_assignment, public.role, public.location TO harbour_sample_owner;
--> statement-breakpoint
GRANT INSERT ON public.audit_event TO harbour_sample_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_role_permission_somewhere(text),
  app.holds_role_permission_at(text, uuid) TO harbour_sample_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sample_people(), app.person_sample_guard(),
  app.remove_sample_batch(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sample_people() TO harbour_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.remove_sample_batch(uuid, text) TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_sample_owner;
--> statement-breakpoint
ALTER FUNCTION app.sample_people() OWNER TO harbour_sample_owner;
--> statement-breakpoint
ALTER FUNCTION app.person_sample_guard() OWNER TO harbour_sample_owner;
--> statement-breakpoint
ALTER FUNCTION app.remove_sample_batch(uuid, text) OWNER TO harbour_sample_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_sample_owner;
