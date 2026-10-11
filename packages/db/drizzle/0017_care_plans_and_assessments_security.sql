-- Care plans, risk assessments, stored assessments, activities, visits and advance care records
-- (slice 4b): the ADR-0002 patterns of migration 0012. Runs as harbour_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'care_plan', 'care_plan_section', 'care_plan_action', 'risk_assessment', 'assessment',
    'activity_record', 'visit_log', 'advance_care_record'
  ] LOOP
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

-- Mutable aggregates: version bump on every change and a record_version row (history view).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'care_plan', 'care_plan_section', 'care_plan_action', 'risk_assessment', 'advance_care_record'
  ] LOOP
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

-- Assessments, activities and visits are append-only (Reg 17, hazard HZ-017): a correction is a
-- new row that supersedes the original with a reason.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assessment', 'activity_record', 'visit_log'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON public.care_plan, public.care_plan_section, public.care_plan_action,
  public.risk_assessment, public.advance_care_record TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.assessment, public.activity_record, public.visit_log TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.assessment, public.activity_record, public.visit_log
  FROM harbour_app;
--> statement-breakpoint

-- Devices hold these for their assigned people (care.md section 6): the care plan summary, risk
-- assessments and advance care records read-only, the last result per tool, and activities and
-- visits written offline. Sync streams (slice 10) decide what reaches a device; logical
-- replication bypasses RLS and the initial snapshot is this plain SELECT.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'care_plan', 'care_plan_section', 'care_plan_action', 'risk_assessment', 'assessment',
    'activity_record', 'visit_log', 'advance_care_record'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.care_plan, public.care_plan_section, public.care_plan_action,
  public.risk_assessment, public.assessment, public.activity_record, public.visit_log,
  public.advance_care_record TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.care_plan, public.care_plan_section,
  public.care_plan_action, public.risk_assessment, public.assessment, public.activity_record,
  public.visit_log, public.advance_care_record;
