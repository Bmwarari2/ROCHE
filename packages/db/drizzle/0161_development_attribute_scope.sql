-- Development reads follow attribute scope (ADR-0136, provisional; WORK-009 follow-up). Until now a
-- member's training, competence, supervision and revalidation records were readable by any holder
-- of a workforce read permission anywhere in the organisation (app.reads_development, migration
-- 0079, after app.holds_staff_permission, migration 0073). Now:
--   - organisation-wide holders (a role with no person scope, as HR's; a tenant-scoped role; a role
--     or grant held organisation-wide) read every member's development records, as before;
--   - a holder at a home reads the records of members who work there, as app.works_at (migration
--     0115) counts it (a role in force there or across the organisation, or that home on their
--     staff profile), and no one else's;
--   - a member still reads their own (workforce.self.read).
-- There is no team or line-manager scope for staff yet (scope kinds are tenant, location, assigned,
-- self and none); assigned and self scopes give no development reads, as before.
-- The reminder tasks raised about a member (kind workforce.training_expiry,
-- workforce.competence_expiry, workforce.supervision_due: source tenant_user) follow the same rule.
-- Expand only: app.reads_development() stays as the gate "holds a development read permission
-- somewhere", and app.task_visible_with (four arguments) stays for any caller; neither widens
-- anything.

-- Whether the session's member holds p_permission with a scope that covers p_worker. Definer
-- rights: the worker's role assignments are read whatever the caller may see of them. It answers
-- yes or no only.
CREATE OR REPLACE FUNCTION app.holds_staff_permission_for(p_permission text, p_worker uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app.current_user_id() IS NOT NULL AND p_worker IS NOT NULL
    -- Only a member of this organisation is ever in scope.
    AND EXISTS (SELECT 1 FROM public.tenant_user tu
                WHERE tu.tenant_id = app.current_tenant_id() AND tu.id = p_worker)
    AND (
    -- Organisation-wide: a tenant-scoped role, or a role or grant held organisation-wide.
    app.holds_permission_at(p_permission, NULL)
    -- A role with no person scope (HR's; migration 0073).
    OR EXISTS (
      SELECT 1
      FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = app.current_tenant_id()
        AND ra.tenant_user_id = app.current_user_id()
        AND ra.deleted_at IS NULL
        AND r.archived_at IS NULL
        AND ra.valid_from <= now()
        AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND r.scope_kind::text = 'none'
        AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
          'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
        AND p_permission = ANY (r.permissions))
    -- At a home where the reader holds the permission and the member works, as app.works_at
    -- (migration 0115) counts it: a role in force there or across the organisation, or that home
    -- on their staff profile.
    OR EXISTS (
      SELECT 1
      FROM public.location l
      WHERE l.tenant_id = app.current_tenant_id()
        AND app.holds_permission_at(p_permission, l.id)
        AND (EXISTS (
              SELECT 1 FROM public.role_assignment wa
              JOIN public.role wr ON wr.id = wa.role_id AND wr.tenant_id = wa.tenant_id
              WHERE wa.tenant_id = l.tenant_id AND wa.tenant_user_id = p_worker
                AND wa.deleted_at IS NULL AND wr.archived_at IS NULL
                AND wa.valid_from <= now() AND (wa.valid_to IS NULL OR wa.valid_to > now())
                AND (wa.location_id = l.id
                  OR (wa.location_id IS NULL AND (wr.scope_kind = 'tenant' OR wa.organisation_wide))))
          OR EXISTS (
              SELECT 1 FROM public.staff_profile sp
              WHERE sp.tenant_id = l.tenant_id AND sp.tenant_user_id = p_worker
                AND sp.location_id = l.id AND sp.deleted_at IS NULL))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.holds_staff_permission_for(text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- harbour_care_definer reads and updates tasks, so it evaluates the task policy below.
GRANT EXECUTE ON FUNCTION app.holds_staff_permission_for(text, uuid)
  TO harbour_app, harbour_care_definer;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.holds_staff_permission_for(text, uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_workforce_definer;
--> statement-breakpoint
-- harbour_owner evaluates the task policy too: granted by the new owner (ADR-0133, as 0151 did).
SET ROLE harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_staff_permission_for(text, uuid) TO harbour_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- Whether the session's member reads p_worker's development records (any of the four read
-- permissions of app.reads_development, in a scope that covers the member). Invoker rights.
CREATE OR REPLACE FUNCTION app.reads_development_of(p_worker uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.holds_staff_permission_for('workforce.training.manage', p_worker)
    OR app.holds_staff_permission_for('workforce.competence.observe', p_worker)
    OR app.holds_staff_permission_for('workforce.supervision.manage', p_worker)
    OR app.holds_staff_permission_for('workforce.staff_file.read', p_worker)
$$;
--> statement-breakpoint

-- The member-keyed development tables (migration 0079).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_record', 'competence_sign_off', 'supervision_record',
      'revalidation_evidence'] LOOP
    EXECUTE format('DROP POLICY development_read ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY development_read ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app '
      'USING (app.is_system() OR app.reads_development_of(worker_id) '
      'OR app.reads_own_development(worker_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
DROP POLICY development_read ON public.competence_withdrawal;
--> statement-breakpoint
CREATE POLICY development_read ON public.competence_withdrawal AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.reads_development_of(app.sign_off_worker(sign_off_id))
    OR app.reads_own_development(app.sign_off_worker(sign_off_id)));
--> statement-breakpoint
-- Earlier versions of development records (migration 0079).
DROP POLICY record_version_development ON public.record_version;
--> statement-breakpoint
CREATE POLICY record_version_development ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('training_record', 'supervision_record', 'revalidation_evidence')
    OR app.is_system() OR app.reads_development_of((data->>'worker_id')::uuid)
    OR app.reads_own_development((data->>'worker_id')::uuid));
--> statement-breakpoint
-- E-learning attempts and statements (migration 0112).
DROP POLICY elearning_attempt_read ON public.elearning_attempt;
--> statement-breakpoint
CREATE POLICY elearning_attempt_read ON public.elearning_attempt AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.reads_development_of(worker_id)
    OR app.reads_own_development(worker_id));
--> statement-breakpoint
DROP POLICY elearning_statement_read ON public.elearning_statement;
--> statement-breakpoint
CREATE POLICY elearning_statement_read ON public.elearning_statement AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.reads_development_of(app.elearning_attempt_worker(attempt_id))
    OR app.reads_own_development(app.elearning_attempt_worker(attempt_id)));
--> statement-breakpoint
DROP POLICY record_version_elearning ON public.record_version;
--> statement-breakpoint
CREATE POLICY record_version_elearning ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name <> 'elearning_attempt'
    OR app.is_system() OR app.reads_development_of((data->>'worker_id')::uuid)
    OR app.reads_own_development((data->>'worker_id')::uuid));
--> statement-breakpoint
-- Training certificates (migration 0132): read and changed within the same scope.
DROP POLICY document_training_certificate_read ON public.document;
--> statement-breakpoint
CREATE POLICY document_training_certificate_read ON public.document AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (category <> 'training_certificate' OR app.is_system()
    OR (subject_type = 'training_record'
        AND (app.reads_development_of(app.training_record_worker(subject_id))
          OR app.reads_own_development(app.training_record_worker(subject_id)))));
--> statement-breakpoint
DROP POLICY document_training_certificate_update ON public.document;
--> statement-breakpoint
CREATE POLICY document_training_certificate_update ON public.document AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (category <> 'training_certificate' OR app.is_system()
    OR (subject_type = 'training_record'
        AND app.reads_development_of(app.training_record_worker(subject_id))
        AND app.training_record_worker(subject_id) IS DISTINCT FROM app.current_user_id()))
  WITH CHECK (category <> 'training_certificate' OR app.is_system()
    OR (subject_type = 'training_record'
        AND app.reads_development_of(app.training_record_worker(subject_id))
        AND app.training_record_worker(subject_id) IS DISTINCT FROM app.current_user_id()));
--> statement-breakpoint

-- Task visibility (migration 0079): a workforce reminder about a member (source tenant_user, with a
-- development permission required) is visible only to holders whose scope covers that member;
-- other workforce tasks with no person and no location keep the organisation-wide rule. The task
-- never gets a location for this: that would show it to everyone at the home (app.task_visible).
CREATE OR REPLACE FUNCTION app.task_visible_for(p_person_id uuid, p_location_id uuid,
  p_assignee uuid, p_required_permission text, p_source_type text, p_source_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.task_visible(p_person_id, p_location_id, p_assignee)
    OR (p_person_id IS NULL AND p_location_id IS NULL
        AND p_required_permission LIKE 'workforce.%'
        AND p_required_permission <> 'workforce.self.read'
        AND CASE
          WHEN p_source_type = 'tenant_user' AND p_source_id IS NOT NULL
               AND p_required_permission IN ('workforce.training.manage',
                 'workforce.competence.observe', 'workforce.supervision.manage',
                 'workforce.staff_file.read')
            THEN app.holds_staff_permission_for(p_required_permission, p_source_id)
          ELSE app.holds_staff_permission(p_required_permission)
        END)
$$;
--> statement-breakpoint
-- The policy keeps the roles it holds today (harbour_app, harbour_owner and the context definers
-- that 0151 added).
DO $$
DECLARE t text; v_roles text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_series', 'task'] LOOP
    SELECT string_agg(quote_ident(r.rolname), ', ' ORDER BY r.rolname) INTO v_roles
      FROM pg_policy pol JOIN pg_roles r ON r.oid = ANY (pol.polroles)
     WHERE pol.polname = 'task_scope' AND pol.polrelid = format('public.%I', t)::regclass;
    EXECUTE format('DROP POLICY task_scope ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY task_scope ON public.%I AS RESTRICTIVE FOR ALL TO %s '
      'USING (app.task_visible_for(person_id, location_id, assignee_tenant_user_id, '
      'required_permission, source_type, source_id)) '
      'WITH CHECK (app.task_visible_for(person_id, location_id, assignee_tenant_user_id, '
      'required_permission, source_type, source_id))', t, v_roles);
  END LOOP;
END
$$;
