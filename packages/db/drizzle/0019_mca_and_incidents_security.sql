-- Consent, capacity, DoLS (slice 6) and incidents and statutory notifications (slice 7): the
-- ADR-0002 patterns of migrations 0012 and 0017, with incident scope from ADR-0033. Runs as
-- harbour_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'consent_record', 'capacity_assessment', 'best_interests_decision', 'dols_authorisation',
    'dols_legal_change_review', 'incident', 'incident_person', 'classifier_answer',
    'statutory_notification', 'candour_record', 'investigation'
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

-- Consent, capacity, best interests and DoLS are about one person and follow that person's scope.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'consent_record', 'capacity_assessment', 'best_interests_decision', 'dols_authorisation',
    'dols_legal_change_review'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------------------------
-- Incident scope (ADR-0033). Invoker rights, like app.person_in_scope: they run under the caller's
-- row-level security, so they can never widen access.
--------------------------------------------------------------------------------------------------

-- An incident is in scope for tenant-wide roles, for the person who raised it, for anyone who can
-- see at least one of the people using the service on it, and, when it involves nobody using the
-- service (a utility failure, a staff injury), for the people working at its location.
CREATE OR REPLACE FUNCTION app.incident_in_scope(
  p_location_id uuid, p_raised_by uuid, p_person_ids uuid[]
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_scope() = 'tenant'
    OR (p_raised_by IS NOT NULL AND p_raised_by = app.current_user_id())
    OR CASE
         WHEN cardinality(p_person_ids) = 0 THEN p_location_id = ANY (app.current_location_ids())
         ELSE EXISTS (SELECT 1 FROM unnest(p_person_ids) AS ip(id) WHERE app.person_visible(ip.id))
       END
$$;
--> statement-breakpoint

-- Child records of an incident follow its visibility (the incident row's own policy decides).
CREATE OR REPLACE FUNCTION app.incident_visible(p_incident_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.incident i WHERE i.id = p_incident_id)
$$;
--> statement-breakpoint

-- Staff and visitors on an incident are third parties: visible with the incident only to
-- tenant-wide roles, the people working at its location and the person who raised it.
CREATE OR REPLACE FUNCTION app.incident_location_visible(p_incident_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.incident i
    WHERE i.id = p_incident_id
      AND (app.current_scope() = 'tenant'
        OR i.location_id = ANY (app.current_location_ids())
        OR i.raised_by = app.current_user_id())
  )
$$;
--> statement-breakpoint

-- A notification about an incident needs the incident; one about a person (a death, a DoLS
-- outcome) needs that person too; one about a location (an outbreak found across its cases)
-- follows location scope.
CREATE OR REPLACE FUNCTION app.statutory_notification_visible(
  p_incident_id uuid, p_person_id uuid, p_location_id uuid
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_incident_id IS NOT NULL THEN
      app.incident_visible(p_incident_id) AND (p_person_id IS NULL OR app.person_visible(p_person_id))
    WHEN p_person_id IS NOT NULL THEN app.person_visible(p_person_id)
    ELSE app.current_scope() = 'tenant' OR p_location_id = ANY (app.current_location_ids())
  END
$$;
--> statement-breakpoint

CREATE POLICY incident_scope ON public.incident AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.incident_in_scope(location_id, raised_by, person_ids))
  WITH CHECK (app.incident_in_scope(location_id, raised_by, person_ids));
--> statement-breakpoint
CREATE POLICY incident_person_scope ON public.incident_person AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (CASE WHEN person_id IS NOT NULL THEN app.person_visible(person_id)
              ELSE app.incident_location_visible(incident_id) END)
  WITH CHECK (CASE WHEN person_id IS NOT NULL THEN app.person_visible(person_id)
                   ELSE app.incident_location_visible(incident_id) END);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['classifier_answer', 'investigation'] LOOP
    EXECUTE format(
      'CREATE POLICY incident_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.incident_visible(incident_id)) WITH CHECK (app.incident_visible(incident_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY incident_child_scope ON public.candour_record AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.incident_visible(incident_id) AND (person_id IS NULL OR app.person_visible(person_id)))
  WITH CHECK (app.incident_visible(incident_id) AND (person_id IS NULL OR app.person_visible(person_id)));
--> statement-breakpoint
CREATE POLICY statutory_notification_scope ON public.statutory_notification AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.statutory_notification_visible(incident_id, person_id, location_id))
  WITH CHECK (app.statutory_notification_visible(incident_id, person_id, location_id));
--> statement-breakpoint

-- A person on an incident must be one of the incident's people (the policy above reads
-- incident.person_ids). Runs with the caller's rights, so the incident must be visible too.
CREATE OR REPLACE FUNCTION app.incident_person_listed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.person_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.incident i WHERE i.id = NEW.incident_id AND NEW.person_id = ANY (i.person_ids)
  ) THEN
    RAISE EXCEPTION 'incident_person: the person is not listed on the incident'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER incident_person_listed BEFORE INSERT OR UPDATE OF person_id, incident_id
  ON public.incident_person FOR EACH ROW EXECUTE FUNCTION app.incident_person_listed();
--> statement-breakpoint

-- Mutable aggregates: version bump on every change and a record_version row (history view).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'consent_record', 'dols_authorisation', 'dols_legal_change_review', 'incident',
    'incident_person', 'statutory_notification', 'candour_record', 'investigation'
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

-- Capacity assessments, best-interests decisions and classifier answers are append-only (Reg 17,
-- HZ-017, HZ-026, HZ-013): a correction is a new row.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['capacity_assessment', 'best_interests_decision', 'classifier_answer'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON public.consent_record, public.dols_authorisation,
  public.dols_legal_change_review, public.incident, public.incident_person,
  public.statutory_notification, public.candour_record, public.investigation TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.capacity_assessment, public.best_interests_decision,
  public.classifier_answer TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.capacity_assessment, public.best_interests_decision,
  public.classifier_answer FROM harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.consent_record, public.dols_authorisation,
  public.dols_legal_change_review, public.incident, public.incident_person,
  public.statutory_notification, public.candour_record, public.investigation FROM harbour_app;
--> statement-breakpoint

-- Devices hold consents, capacity findings and DoLS status read-only for their assigned people
-- (care.md section 6) and capture incidents offline (safety.md section 6). Sync streams decide
-- what reaches a device; logical replication bypasses RLS and the initial snapshot is this SELECT.
-- Statutory notifications, candour and investigations stay on the server.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'consent_record', 'capacity_assessment', 'best_interests_decision', 'dols_authorisation',
    'incident', 'incident_person'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.consent_record, public.capacity_assessment, public.best_interests_decision,
  public.dols_authorisation, public.incident, public.incident_person TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.consent_record, public.capacity_assessment,
  public.best_interests_decision, public.dols_authorisation, public.incident,
  public.incident_person;
