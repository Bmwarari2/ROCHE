-- Point-of-care record security (ADR-0002 patterns). Runs as harbour_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['person_care_profile', 'care_note', 'observation', 'body_map_mark'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    -- Everything here is about one person and follows that person's scope.
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.person_care_profile
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.person_care_profile
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

-- Notes, observations and marks are append-only (Reg 17, hazard HZ-017).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['care_note', 'observation', 'body_map_mark'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.person_care_profile TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.care_note, public.observation, public.body_map_mark TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.care_note, public.observation, public.body_map_mark
  FROM harbour_app;
--> statement-breakpoint

-- Devices sync these for their assigned people (packages/sync streams decide what reaches a
-- device; logical replication itself bypasses RLS, the initial snapshot is this plain SELECT).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['person_care_profile', 'care_note', 'observation', 'body_map_mark'] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.person_care_profile, public.care_note, public.observation, public.body_map_mark
  TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.person_care_profile, public.care_note,
  public.observation, public.body_map_mark;
