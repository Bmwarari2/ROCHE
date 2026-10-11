ALTER TABLE "exit_record" ALTER COLUMN "learning_disability_or_autism" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "allergy_status_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "allergy_status_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "cancel_code" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "evidence_after_close" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_series" ADD COLUMN "inactive_code" text;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_allergy_confirmed_by_fk" FOREIGN KEY ("tenant_id","allergy_status_confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_cancel_code" CHECK (cancel_code IS NULL OR (status = 'cancelled' AND cancel_code IN ('paused_while_away', 'ended_at_exit', 'exit_recorded_in_error', 'planned_exit_cancelled', 'missed_before_return_recorded')));--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_inactive_code" CHECK (inactive_code IS NULL OR (NOT active AND inactive_code IN ('paused_while_away', 'ended_at_exit', 'exit_recorded_in_error', 'planned_exit_cancelled', 'missed_before_return_recorded')));--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "task_outcome" text;--> statement-breakpoint
ALTER TABLE "assessment" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "assessment" ADD COLUMN "task_outcome" text;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "task_outcome" text;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "task_outcome" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "task_outcome" text;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "task_outcome" text;--> statement-breakpoint
ALTER TABLE "exit_record" ADD COLUMN "status_before" text;--> statement-breakpoint
ALTER TABLE "exit_record" ADD COLUMN "status_before_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "stopped_by_exit_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "task_series" ADD COLUMN "stopped_by_exit_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked')));--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked')));--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked')));--> statement-breakpoint
ALTER TABLE "care_note" ADD CONSTRAINT "care_note_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked')));--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked')));--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked')));--> statement-breakpoint
ALTER TABLE "exit_record" ADD CONSTRAINT "exit_record_status_before" CHECK (status_before IS NULL OR status_before IN ('active', 'on_leave', 'in_hospital'));--> statement-breakpoint

-- Slice 8 review fixes (people.md sections 4 and 7).
--
-- 1. Task stop codes: the people lifecycle marks what it cancels or stops with a code, and the
--    exit that stopped it, so a correction (a discharge or death recorded in error) or a return
--    reopens exactly those tasks and series. Existing rows are coded only when they were written
--    in the same transaction as the lifecycle event that stopped them (the event's occurred_at and
--    the row's updated_at are both that transaction's now()); matching on the reason text alone
--    would also code a series a user ended with the same words (/v1/task-series/{id}/end). FORCE
--    is lifted for these statements only (no tenant is set while migrating) and the versioning
--    triggers are paused: coding a row is not a change a client must be refused as stale for.
--    packages/db/test/people-lifecycle.test.ts re-runs the statements between the markers.
-- backfill: begin
ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task_series NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outbox_event NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.exit_record NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task DISABLE TRIGGER touch_mutable;
--> statement-breakpoint
ALTER TABLE public.task DISABLE TRIGGER capture_version;
--> statement-breakpoint
ALTER TABLE public.task_series DISABLE TRIGGER touch_mutable;
--> statement-breakpoint
ALTER TABLE public.task_series DISABLE TRIGGER capture_version;
--> statement-breakpoint
UPDATE public.task t SET cancel_code = 'paused_while_away'
  FROM public.outbox_event o
  WHERE t.status = 'cancelled' AND t.cancel_code IS NULL AND t.series_id IS NOT NULL
    AND t.status_reason = 'Paused while the person is away'
    AND o.tenant_id = t.tenant_id AND o.aggregate_type = 'person'
    AND o.aggregate_id = t.person_id::text
    AND o.event_type IN ('people.person.went_to_hospital', 'people.person.went_on_leave')
    AND o.occurred_at = t.updated_at;
--> statement-breakpoint
UPDATE public.task t SET cancel_code = 'ended_at_exit',
    stopped_by_exit_id = (o.payload ->> 'exitRecordId')::uuid
  FROM public.outbox_event o
  WHERE t.status = 'cancelled' AND t.cancel_code IS NULL
    AND t.status_reason IN ('The person left the service', 'The person moved to another provider',
      'The person died')
    AND o.tenant_id = t.tenant_id AND o.aggregate_type = 'person'
    AND o.aggregate_id = t.person_id::text
    AND o.event_type IN ('people.person.discharged', 'people.person.died')
    AND o.occurred_at = t.updated_at AND o.payload ->> 'exitRecordId' IS NOT NULL;
--> statement-breakpoint
UPDATE public.task_series s SET inactive_code = 'ended_at_exit',
    stopped_by_exit_id = (o.payload ->> 'exitRecordId')::uuid
  FROM public.outbox_event o
  WHERE NOT s.active AND s.inactive_code IS NULL AND s.person_id IS NOT NULL
    AND o.tenant_id = s.tenant_id AND o.aggregate_type = 'person'
    AND o.aggregate_id = s.person_id::text
    AND o.event_type IN ('people.person.discharged', 'people.person.died')
    AND o.occurred_at = s.updated_at AND o.payload ->> 'exitRecordId' IS NOT NULL;
--> statement-breakpoint
UPDATE public.task t SET cancel_code = 'exit_recorded_in_error'
  FROM public.outbox_event o
  WHERE t.status = 'cancelled' AND t.cancel_code IS NULL AND t.kind = 'people.exit_checklist'
    AND t.status_reason = 'The exit was recorded in error'
    AND o.tenant_id = t.tenant_id AND o.aggregate_type = 'person'
    AND o.aggregate_id = t.person_id::text AND o.event_type = 'people.person.status_corrected'
    AND o.occurred_at = t.updated_at;
--> statement-breakpoint
UPDATE public.task t SET cancel_code = 'planned_exit_cancelled'
  FROM public.exit_record e
  WHERE t.status = 'cancelled' AND t.cancel_code IS NULL AND t.kind = 'people.exit_checklist'
    AND t.status_reason = 'The planned exit was cancelled' AND t.source_type = 'exit_record'
    AND e.tenant_id = t.tenant_id AND e.id = t.source_id AND e.state = 'cancelled'
    AND e.updated_at = t.updated_at;
--> statement-breakpoint
ALTER TABLE public.task ENABLE TRIGGER touch_mutable;
--> statement-breakpoint
ALTER TABLE public.task ENABLE TRIGGER capture_version;
--> statement-breakpoint
ALTER TABLE public.task_series ENABLE TRIGGER touch_mutable;
--> statement-breakpoint
ALTER TABLE public.task_series ENABLE TRIGGER capture_version;
--> statement-breakpoint
ALTER TABLE public.task FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task_series FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outbox_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.exit_record FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- backfill: end

-- 2. Who set the allergy status and when (HZ-007). "No known allergies" prints with the person
--    who confirmed it, not whoever last edited the person row. The confirmer is always the
--    database's record of the writer (app.current_user_id() and now()), never a value the writer
--    supplies: any write that changes the status or either confirmer column sets both, and a
--    status of unknown clears them. Rows from before this migration keep no confirmer (it was
--    never recorded) and print as such.
CREATE OR REPLACE FUNCTION app.person_allergy_status_confirmed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.allergy_status IS DISTINCT FROM OLD.allergy_status
     OR NEW.allergy_status_confirmed_by IS DISTINCT FROM OLD.allergy_status_confirmed_by
     OR NEW.allergy_status_confirmed_at IS DISTINCT FROM OLD.allergy_status_confirmed_at THEN
    IF NEW.allergy_status::text = 'unknown' THEN
      NEW.allergy_status_confirmed_by := NULL;
      NEW.allergy_status_confirmed_at := NULL;
    ELSE
      NEW.allergy_status_confirmed_by := app.current_user_id();
      NEW.allergy_status_confirmed_at :=
        CASE WHEN NEW.allergy_status_confirmed_by IS NULL THEN NULL ELSE now() END;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER person_allergy_status_confirmed
  BEFORE INSERT OR UPDATE OF allergy_status, allergy_status_confirmed_by,
    allergy_status_confirmed_at
  ON public.person FOR EACH ROW EXECUTE FUNCTION app.person_allergy_status_confirmed();
--> statement-breakpoint

-- 3. About Me, the pre-admission assessment and the property inventory leave the replication
--    publication. Slice 8 published them with no sync streams and no isolation tests through
--    PowerSync (replication bypasses row-level security). The offline transfer pack (mobile work)
--    adds them back with streams pinned to the user's assignments and two-tenant stream tests.
ALTER PUBLICATION powersync DROP TABLE public.about_me, public.pre_admission_assessment,
  public.property_item;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['about_me', 'pre_admission_assessment', 'property_item'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS sync_replication_read ON public.%I', t);
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE SELECT ON public.about_me, public.pre_admission_assessment, public.property_item
  FROM harbour_sync;
