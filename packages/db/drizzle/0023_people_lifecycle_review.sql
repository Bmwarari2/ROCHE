ALTER TABLE "exit_record" ALTER COLUMN "learning_disability_or_autism" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "allergy_status_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "allergy_status_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "cancel_code" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "evidence_after_close" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_series" ADD COLUMN "inactive_code" text;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_allergy_confirmed_by_fk" FOREIGN KEY ("tenant_id","allergy_status_confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_cancel_code" CHECK (cancel_code IS NULL OR (status = 'cancelled' AND cancel_code IN ('paused_while_away', 'ended_at_exit', 'exit_recorded_in_error', 'planned_exit_cancelled')));--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_inactive_code" CHECK (inactive_code IS NULL OR (NOT active AND inactive_code IN ('paused_while_away', 'ended_at_exit', 'exit_recorded_in_error', 'planned_exit_cancelled')));--> statement-breakpoint

-- Slice 8 review fixes (people.md sections 4 and 7).
--
-- 1. Task stop codes: the people lifecycle marks what it cancels or stops with a code, so a
--    correction (a discharge or death recorded in error) or a return reopens exactly those tasks
--    and series. Existing rows are coded from the wording the slice 8 API wrote. FORCE is lifted
--    for these statements only (no tenant is set while migrating) and the versioning triggers are
--    paused: coding a row is not a change a client must be refused as stale for.
ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task DISABLE TRIGGER touch_mutable;
--> statement-breakpoint
ALTER TABLE public.task DISABLE TRIGGER capture_version;
--> statement-breakpoint
UPDATE public.task SET cancel_code = CASE status_reason
    WHEN 'Paused while the person is away' THEN 'paused_while_away'
    WHEN 'The person left the service' THEN 'ended_at_exit'
    WHEN 'The person moved to another provider' THEN 'ended_at_exit'
    WHEN 'The person died' THEN 'ended_at_exit'
    WHEN 'The exit was recorded in error' THEN 'exit_recorded_in_error'
    WHEN 'The planned exit was cancelled' THEN 'planned_exit_cancelled'
  END
  WHERE status = 'cancelled' AND cancel_code IS NULL AND status_reason IN (
    'Paused while the person is away', 'The person left the service',
    'The person moved to another provider', 'The person died', 'The exit was recorded in error',
    'The planned exit was cancelled');
--> statement-breakpoint
ALTER TABLE public.task ENABLE TRIGGER touch_mutable;
--> statement-breakpoint
ALTER TABLE public.task ENABLE TRIGGER capture_version;
--> statement-breakpoint
ALTER TABLE public.task FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- 2. Who set the allergy status and when (HZ-007). "No known allergies" prints with the person
--    who confirmed it, not whoever last edited the person row. The trigger records the caller
--    whenever the status changes and the writer did not name a confirmer. Rows from before this
--    migration keep no confirmer (it was never recorded) and print as such.
CREATE OR REPLACE FUNCTION app.person_allergy_status_confirmed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.allergy_status::text <> 'unknown' AND NEW.allergy_status_confirmed_at IS NULL THEN
      NEW.allergy_status_confirmed_by := COALESCE(NEW.allergy_status_confirmed_by, app.current_user_id());
      NEW.allergy_status_confirmed_at := now();
    END IF;
  ELSIF NEW.allergy_status IS DISTINCT FROM OLD.allergy_status
     AND NEW.allergy_status_confirmed_at IS NOT DISTINCT FROM OLD.allergy_status_confirmed_at THEN
    NEW.allergy_status_confirmed_by := app.current_user_id();
    NEW.allergy_status_confirmed_at := now();
  END IF;
  IF NEW.allergy_status::text = 'unknown' THEN
    NEW.allergy_status_confirmed_by := NULL;
    NEW.allergy_status_confirmed_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER person_allergy_status_confirmed BEFORE INSERT OR UPDATE OF allergy_status
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
