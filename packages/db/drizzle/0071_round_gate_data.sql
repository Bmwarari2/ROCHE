ALTER TABLE "handover_item" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "from_earlier_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "handover_item" ADD CONSTRAINT "handover_item_summary" CHECK (summary IS NULL OR coalesce(jsonb_typeof(summary) = 'object' AND jsonb_typeof(summary -> 'key') = 'string' AND summary ->> 'key' LIKE 'handover.summary.%' AND jsonb_typeof(summary -> 'params') = 'object', false));--> statement-breakpoint
-- The screens gate for the round and the handover on the phone (STATUS item 15; care.md section
-- 6). Expand-only: two columns, empty or false on every existing row until the backfill below.
-- Runs as harbour_owner.
--
-- (a) `handover_item.summary`: what an item says, as a catalogue key and its parameters, written
-- once when the item is compiled or added (items stay append-only; HZ-018). Nothing to backfill:
-- items compiled before this migration keep no summary and a screen words them by their kind.
--
-- (b) `task.from_earlier_plan`: the round view's "From an earlier plan: check the current plan"
-- (`planRoundNotice` in packages/domain; HZ-024) kept on the task itself, so the phone can say it
-- offline without the plan or the series. It mirrors the round view exactly: a round of a care
-- plan series is from an earlier plan unless its plan is active and the series still runs (active,
-- or paused by the people lifecycle with an inactive code). The database keeps it, never the API:
-- a task gets it when it is written while open, and the open rounds of a series get it again when
-- the series changes (at once) or its plan's status does (at the end of that transaction, so a plan
-- published with its series carried forward in the same transaction changes no round and bumps no
-- version). The plan's trigger is deferred: a later migration that changes a plan's status and then
-- alters `care_plan` in one transaction sets it immediate first (`SET CONSTRAINTS`).
-- `app.task_from_earlier_plan` reads the series and plan in the system's view of the caller's own
-- organisation (as `app.seed_discard_reasons` does), so who made the change never decides it.
CREATE OR REPLACE FUNCTION app.task_from_earlier_plan(p_series_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  prev_scope text := current_setting('app.scope', true);
  v_earlier boolean;
BEGIN
  IF p_series_id IS NULL OR v_tenant IS NULL THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.scope', 'tenant', true);
  SELECT NOT (p.status = 'active' AND (s.active OR s.inactive_code IS NOT NULL)) INTO v_earlier
    FROM public.task_series s
    JOIN public.care_plan_action a ON a.tenant_id = s.tenant_id AND a.id = s.source_id
    JOIN public.care_plan p ON p.tenant_id = a.tenant_id AND p.id = a.plan_id
   WHERE s.tenant_id = v_tenant AND s.id = p_series_id AND s.source_type = 'care_plan_action';
  PERFORM set_config('app.scope', coalesce(prev_scope, ''), true);
  RETURN coalesce(v_earlier, false);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.task_from_earlier_plan(uuid) FROM PUBLIC;
--> statement-breakpoint
-- The open rounds of these series, again; only those whose flag changes are written.
CREATE OR REPLACE FUNCTION app.refresh_earlier_plan(p_series_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prev_scope text := current_setting('app.scope', true);
BEGIN
  IF app.current_tenant_id() IS NULL OR coalesce(cardinality(p_series_ids), 0) = 0 THEN
    RETURN;
  END IF;
  PERFORM set_config('app.scope', 'tenant', true);
  UPDATE public.task t
     SET from_earlier_plan = app.task_from_earlier_plan(t.series_id)
   WHERE t.tenant_id = app.current_tenant_id()
     AND t.series_id = ANY (p_series_ids)
     AND t.status IN ('open', 'in_progress')
     AND t.deleted_at IS NULL
     AND t.from_earlier_plan IS DISTINCT FROM app.task_from_earlier_plan(t.series_id);
  PERFORM set_config('app.scope', coalesce(prev_scope, ''), true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.refresh_earlier_plan(uuid[]) FROM PUBLIC;
--> statement-breakpoint
-- A task written while open takes the flag from its series, whatever the writer sent.
CREATE OR REPLACE FUNCTION app.task_earlier_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status IN ('open', 'in_progress') THEN
    NEW.from_earlier_plan := app.task_from_earlier_plan(NEW.series_id);
  ELSIF TG_OP = 'INSERT' THEN
    NEW.from_earlier_plan := false;
  ELSE
    NEW.from_earlier_plan := OLD.from_earlier_plan;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER task_earlier_plan BEFORE INSERT OR UPDATE ON public.task
  FOR EACH ROW EXECUTE FUNCTION app.task_earlier_plan();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.task_series_earlier_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM app.refresh_earlier_plan(ARRAY[NEW.id]);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER task_series_earlier_plan
  AFTER UPDATE OF active, inactive_code, source_type, source_id ON public.task_series
  FOR EACH ROW EXECUTE FUNCTION app.task_series_earlier_plan();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.care_plan_earlier_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prev_scope text := current_setting('app.scope', true);
  v_series uuid[];
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.scope', 'tenant', true);
  SELECT array_agg(s.id) INTO v_series
    FROM public.task_series s
    JOIN public.care_plan_action a ON a.tenant_id = s.tenant_id AND a.id = s.source_id
   WHERE s.tenant_id = NEW.tenant_id AND s.source_type = 'care_plan_action'
     AND a.plan_id = NEW.id;
  PERFORM set_config('app.scope', coalesce(prev_scope, ''), true);
  PERFORM app.refresh_earlier_plan(v_series);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER care_plan_earlier_plan
  AFTER UPDATE OF status ON public.care_plan
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.care_plan_earlier_plan();
--> statement-breakpoint
-- The open rounds already from an earlier plan, in each organisation's view. FORCE is lifted on
-- the task table only to find the organisations, and restored at the end. Idempotent.
-- backfill: begin
ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.task
           WHERE series_id IS NOT NULL AND status IN ('open', 'in_progress')
             AND deleted_at IS NULL ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    PERFORM app.refresh_earlier_plan(ARRAY(
      SELECT DISTINCT series_id FROM public.task
       WHERE tenant_id = t AND series_id IS NOT NULL AND status IN ('open', 'in_progress')
         AND deleted_at IS NULL));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.task FORCE ROW LEVEL SECURITY;
-- backfill: end
