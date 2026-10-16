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

-- How many sample and real people the organisation has (not deleted), whatever the caller's
-- scope: the guards need the whole organisation, so this reads as its own NOLOGIN owner.
CREATE OR REPLACE FUNCTION app.sample_people() RETURNS TABLE (sample_count bigint, real_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*) FILTER (WHERE p.is_sample), count(*) FILTER (WHERE NOT p.is_sample)
    FROM public.person p
   WHERE p.tenant_id = app.current_tenant_id() AND p.deleted_at IS NULL
$$;
--> statement-breakpoint

-- Real and sample people never share a list (rule 30): a real person waits until the sample data
-- has gone, by every creation path; a sample person is loaded only while no real person exists;
-- and a person never changes between the two.
CREATE OR REPLACE FUNCTION app.person_sample_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_sample bigint; v_real bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.is_sample, NEW.sample_batch_id) IS DISTINCT FROM (OLD.is_sample, OLD.sample_batch_id) THEN
      RAISE EXCEPTION 'sample_flag_fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT s.sample_count, s.real_count INTO v_sample, v_real FROM app.sample_people() s;
  IF NEW.is_sample AND v_real > 0 THEN
    RAISE EXCEPTION 'real_people_exist' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW.is_sample AND v_sample > 0 THEN
    RAISE EXCEPTION 'remove_sample_data_first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER person_sample_guard BEFORE INSERT OR UPDATE ON public.person
  FOR EACH ROW EXECUTE FUNCTION app.person_sample_guard();
--> statement-breakpoint

-- Removes a whole batch or nothing (rule 32): a holder of platform.onboarding.manage, a batch of
-- this organisation not yet removed, none of its people under a legal hold, none referred to by
-- another record; the batch row records the removal and the organisation's audit trail keeps it
-- (ids and counts only). Audit events about the sample people stay.
CREATE OR REPLACE FUNCTION app.remove_sample_batch(p_batch uuid, p_request_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_removed integer;
BEGIN
  IF v_me IS NULL OR NOT app.holds_role_permission_somewhere('platform.onboarding.manage') THEN
    RAISE EXCEPTION 'missing_permission' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM public.sample_batch b
    WHERE b.id = p_batch AND b.tenant_id = app.current_tenant_id() AND b.removed_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nothing_to_remove' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.legal_hold h JOIN public.person p ON p.id = h.person_id
     WHERE h.tenant_id = app.current_tenant_id() AND p.tenant_id = h.tenant_id
       AND p.sample_batch_id = p_batch AND h.released_at IS NULL) THEN
    RAISE EXCEPTION 'held' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    DELETE FROM public.person p
     WHERE p.tenant_id = app.current_tenant_id() AND p.sample_batch_id = p_batch AND p.is_sample;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'referenced_by_real_records' USING ERRCODE = 'check_violation';
  END;
  UPDATE public.sample_batch SET removed_at = now(), removed_by = v_me WHERE id = p_batch;
  INSERT INTO public.audit_event (tenant_id, actor_tenant_user_id, action, resource_type,
    resource_id, scope, request_id)
  VALUES (app.current_tenant_id(), v_me, 'platform.onboarding.sample_removed', 'sample_batch',
    p_batch::text, jsonb_build_object('people', v_removed), p_request_id);
  RETURN v_removed;
END
$$;
--> statement-breakpoint

-- What harbour_sample_owner's functions need, and nothing else. Execute rights are set before
-- the owner changes (ADR-0002).
GRANT USAGE ON SCHEMA public, app TO harbour_sample_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, is_sample, sample_batch_id, deleted_at), DELETE ON public.person
  TO harbour_sample_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, removed_at), UPDATE (removed_at, removed_by)
  ON public.sample_batch TO harbour_sample_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, person_id, released_at) ON public.legal_hold TO harbour_sample_owner;
--> statement-breakpoint
GRANT SELECT ON public.role_assignment, public.role, public.location TO harbour_sample_owner;
--> statement-breakpoint
GRANT INSERT ON public.audit_event TO harbour_sample_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sample_people(), app.remove_sample_batch(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sample_people() TO harbour_app, harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.remove_sample_batch(uuid, text) TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_sample_owner;
--> statement-breakpoint
ALTER FUNCTION app.sample_people() OWNER TO harbour_sample_owner;
--> statement-breakpoint
ALTER FUNCTION app.remove_sample_batch(uuid, text) OWNER TO harbour_sample_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_sample_owner;
