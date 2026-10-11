-- Task and workflow engine security (ADR-0002 patterns). Runs as harbour_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_series', 'task', 'workflow_instance', 'workflow_transition'] LOOP
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

-- A task about a person follows that person's visibility. Any other task is visible to tenant-wide
-- roles, to its assignee, and to people working at its location.
CREATE OR REPLACE FUNCTION app.task_visible(p_person_id uuid, p_location_id uuid, p_assignee uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_person_id IS NOT NULL THEN app.person_visible(p_person_id)
    ELSE app.current_scope() = 'tenant'
      OR (p_assignee IS NOT NULL AND p_assignee = app.current_user_id())
      OR (p_location_id IS NOT NULL AND p_location_id = ANY (app.current_location_ids()))
  END
$$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_series', 'task'] LOOP
    EXECUTE format(
      'CREATE POLICY task_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.task_visible(person_id, location_id, assignee_tenant_user_id)) '
      'WITH CHECK (app.task_visible(person_id, location_id, assignee_tenant_user_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['workflow_instance', 'workflow_transition'] LOOP
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (person_id IS NULL OR app.person_visible(person_id)) '
      'WITH CHECK (person_id IS NULL OR app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Mutable aggregates: version bump and history. Transitions are append-only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_series', 'task', 'workflow_instance'] LOOP
    EXECUTE format(
      'CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format(
      'CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.workflow_transition
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.workflow_transition
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.task_series, public.task, public.workflow_instance TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.workflow_transition TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.workflow_transition FROM harbour_app;
