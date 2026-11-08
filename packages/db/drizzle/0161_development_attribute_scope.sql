-- Development reads and writes follow attribute scope (ADR-0136, provisional; WORK-009 follow-up).
-- Until now a member's training, competence, supervision and revalidation records were readable,
-- and writable, by any holder of a workforce permission anywhere in the organisation
-- (app.reads_development, migration 0079, after app.holds_staff_permission, migration 0073). Now:
--   - organisation-wide holders (a role with no person scope, as HR's; a tenant-scoped role; a role
--     or grant held organisation-wide) read and write every member's development records;
--   - a holder at a home (a role there, or an access grant there, such as acting up) reads and
--     writes the records of members who work there, as app.works_at (migration 0115) counts it: a
--     role in force there or across the organisation, or that home on their staff profile;
--   - a member still reads their own (workforce.self.read);
--   - assigned and self scopes give no development reads, as before (app.holds_permission_at counts
--     only tenant and location roles).
-- There is no team or line-manager scope for staff yet (scope kinds are tenant, location, assigned,
-- self and none). The reminder tasks raised about a member (source tenant_user) follow the same
-- rule. LMS import (migration 0132) moves whole organisations' learners, so it is for
-- organisation-wide holders of workforce.training.manage only.
-- Expand only: app.reads_development() stays as the gate "holds a development read permission
-- somewhere", and app.task_visible_with (four arguments) stays and is reused below.

-- Whether the session's member holds p_permission organisation-wide: a tenant-scoped role, a role
-- or grant held organisation-wide, or a role with no person scope (HR's; migration 0073).
-- Invoker rights, as app.holds_staff_permission: it reads the caller's own roles.
CREATE OR REPLACE FUNCTION app.holds_staff_permission_everywhere(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND (
    app.holds_permission_at(p_permission, NULL)
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
        AND p_permission = ANY (r.permissions)))
$$;
--> statement-breakpoint

-- The members, of p_workers, whose development records the session's member reaches with any of
-- p_permissions: all of this organisation's members for an organisation-wide holder; otherwise the
-- members who work at a home where the reader holds one of them (a role in force there, or an
-- access grant there). One set-based query: the reader's homes are found once. Definer rights: the
-- members' role assignments and staff profiles are read whatever the caller may see of them; only
-- member ids the caller passed in come back.
CREATE OR REPLACE FUNCTION app.development_scope_members(p_permissions text[], p_workers uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH everywhere AS (
    SELECT EXISTS (SELECT 1 FROM unnest(p_permissions) AS p(permission)
                   WHERE app.holds_staff_permission_everywhere(p.permission)) AS yes
  ),
  homes AS (
    SELECT ra.location_id
    FROM public.role_assignment ra
    JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
    WHERE ra.tenant_id = app.current_tenant_id()
      AND ra.tenant_user_id = app.current_user_id()
      AND ra.location_id IS NOT NULL
      AND ra.deleted_at IS NULL
      AND r.archived_at IS NULL
      AND ra.valid_from <= now()
      AND (ra.valid_to IS NULL OR ra.valid_to > now())
      AND r.scope_kind::text IN ('tenant', 'location')
      AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
        'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
      AND r.permissions && p_permissions
    UNION
    SELECT g.location_id
    FROM public.access_grant g
    WHERE g.tenant_id = app.current_tenant_id()
      AND g.tenant_user_id = app.current_user_id()
      AND g.location_id IS NOT NULL
      AND g.deleted_at IS NULL
      AND g.revoked_at IS NULL
      AND g.valid_from <= now()
      AND g.valid_to > now()
      AND g.permissions && p_permissions
  )
  SELECT tu.id
  FROM public.tenant_user tu
  WHERE app.current_user_id() IS NOT NULL
    AND tu.tenant_id = app.current_tenant_id()
    AND tu.id = ANY (p_workers)
    AND ((SELECT yes FROM everywhere)
      OR (EXISTS (SELECT 1 FROM homes) AND (
        EXISTS (
          SELECT 1
          FROM public.role_assignment wa
          JOIN public.role wr ON wr.id = wa.role_id AND wr.tenant_id = wa.tenant_id
          WHERE wa.tenant_id = tu.tenant_id
            AND wa.tenant_user_id = tu.id
            AND wa.deleted_at IS NULL
            AND wr.archived_at IS NULL
            AND wa.valid_from <= now()
            AND (wa.valid_to IS NULL OR wa.valid_to > now())
            AND (wa.location_id IN (SELECT location_id FROM homes)
              OR (wa.location_id IS NULL AND (wr.scope_kind = 'tenant' OR wa.organisation_wide))))
        OR EXISTS (
          SELECT 1
          FROM public.staff_profile sp
          WHERE sp.tenant_id = tu.tenant_id
            AND sp.tenant_user_id = tu.id
            AND sp.deleted_at IS NULL
            AND sp.location_id IN (SELECT location_id FROM homes)))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.development_scope_members(text[], uuid[]) FROM PUBLIC;
--> statement-breakpoint
-- The row-level policies below call it for harbour_app; the context definers that read tasks
-- (harbour_care_definer; harbour_platform_definer moves a task's routing column) evaluate the
-- task policy too.
GRANT EXECUTE ON FUNCTION app.development_scope_members(text[], uuid[])
  TO harbour_app, harbour_care_definer, harbour_platform_definer;
--> statement-breakpoint

-- Whether the session's member holds the permission with a scope covering the member, and whether
-- they read the member's development records (any of the four read permissions). Invoker rights.
CREATE OR REPLACE FUNCTION app.holds_staff_permission_for(p_permission text, p_worker uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT p_worker IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.development_scope_members(ARRAY[p_permission], ARRAY[p_worker]))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reads_development_of(p_worker uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT p_worker IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.development_scope_members(ARRAY['workforce.training.manage',
      'workforce.competence.observe', 'workforce.supervision.manage', 'workforce.staff_file.read'],
      ARRAY[p_worker]))
$$;
--> statement-breakpoint

-- HZ-119: whether a member's competence was withdrawn after a day. The sign-off guard asks it with
-- definer rights, so it sees every withdrawal whoever inserts the sign-off. Yes or no only.
CREATE OR REPLACE FUNCTION app.competence_withdrawn_after(p_worker uuid, p_competence text,
  p_on date)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.competence_withdrawal w
    JOIN public.competence_sign_off s ON s.tenant_id = w.tenant_id AND s.id = w.sign_off_id
    WHERE w.tenant_id = app.current_tenant_id()
      AND s.worker_id = p_worker AND s.competence = p_competence
      AND (w.created_at AT TIME ZONE 'Europe/London')::date > p_on)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.competence_withdrawn_after(uuid, text, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.competence_withdrawn_after(uuid, text, date) TO harbour_app;
--> statement-breakpoint
GRANT SELECT ON public.competence_sign_off, public.competence_withdrawal TO harbour_workforce_definer;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.development_scope_members(text[], uuid[]) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.competence_withdrawn_after(uuid, text, date) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_workforce_definer;
--> statement-breakpoint
-- harbour_owner evaluates the task policy and inserts sign-offs in seeds: granted by the new owner
-- (ADR-0133, as 0151 did).
SET ROLE harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.development_scope_members(text[], uuid[]) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.competence_withdrawn_after(uuid, text, date) TO harbour_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- HZ-119 (migration 0079): the same rules, with the withdrawal lookup through the definer above.
CREATE OR REPLACE FUNCTION app.competence_sign_off_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_key text := CASE WHEN NEW.competence IN ('medicines_administration', 'controlled_drugs',
      'insulin_administration', 'epilepsy_rescue_medication')
    THEN 'competence.medicines.refresh_months' ELSE 'competence.default_refresh_months' END;
  v_months numeric := app.quality_rate(v_key, NEW.observed_on::timestamptz);
BEGIN
  IF v_months IS NULL THEN
    RAISE EXCEPTION 'No % figure', v_key USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.valid_until IS DISTINCT FROM
     ((NEW.observed_on + make_interval(months => v_months::int))::date - 1) THEN
    RAISE EXCEPTION 'A sign-off is valid until the day before its refresh'
      USING ERRCODE = 'check_violation';
  END IF;
  IF app.competence_withdrawn_after(NEW.worker_id, NEW.competence, NEW.observed_on) THEN
    RAISE EXCEPTION 'A sign-off is observed on or after the day the competence was withdrawn'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Reads (ALTER POLICY keeps each policy's roles).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_record', 'competence_sign_off', 'supervision_record',
      'revalidation_evidence'] LOOP
    EXECUTE format(
      'ALTER POLICY development_read ON public.%I '
      'USING (app.is_system() OR app.reads_development_of(worker_id) '
      'OR app.reads_own_development(worker_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER POLICY development_read ON public.competence_withdrawal
  USING (app.is_system() OR app.reads_development_of(app.sign_off_worker(sign_off_id))
    OR app.reads_own_development(app.sign_off_worker(sign_off_id)));
--> statement-breakpoint
ALTER POLICY record_version_development ON public.record_version
  USING (table_name NOT IN ('training_record', 'supervision_record', 'revalidation_evidence')
    OR app.is_system() OR app.reads_development_of((data->>'worker_id')::uuid)
    OR app.reads_own_development((data->>'worker_id')::uuid));
--> statement-breakpoint
ALTER POLICY elearning_attempt_read ON public.elearning_attempt
  USING (app.is_system() OR app.reads_development_of(worker_id)
    OR app.reads_own_development(worker_id));
--> statement-breakpoint
ALTER POLICY elearning_statement_read ON public.elearning_statement
  USING (app.is_system() OR app.reads_development_of(app.elearning_attempt_worker(attempt_id))
    OR app.reads_own_development(app.elearning_attempt_worker(attempt_id)));
--> statement-breakpoint
ALTER POLICY record_version_elearning ON public.record_version
  USING (table_name <> 'elearning_attempt'
    OR app.is_system() OR app.reads_development_of((data->>'worker_id')::uuid)
    OR app.reads_own_development((data->>'worker_id')::uuid));
--> statement-breakpoint
ALTER POLICY document_training_certificate_read ON public.document
  USING (category <> 'training_certificate' OR app.is_system()
    OR (subject_type = 'training_record'
        AND (app.reads_development_of(app.training_record_worker(subject_id))
          OR app.reads_own_development(app.training_record_worker(subject_id)))));
--> statement-breakpoint
ALTER POLICY document_training_certificate_update ON public.document
  USING (category <> 'training_certificate' OR app.is_system()
    OR (subject_type = 'training_record'
        AND app.reads_development_of(app.training_record_worker(subject_id))
        AND app.training_record_worker(subject_id) IS DISTINCT FROM app.current_user_id()))
  WITH CHECK (category <> 'training_certificate' OR app.is_system()
    OR (subject_type = 'training_record'
        AND app.reads_development_of(app.training_record_worker(subject_id))
        AND app.training_record_worker(subject_id) IS DISTINCT FROM app.current_user_id()));
--> statement-breakpoint

-- Writes: the permission in a scope covering the member, as the reads (migrations 0079, 0107, 0132).
ALTER POLICY training_record_insert ON public.training_record
  WITH CHECK (app.is_system() OR (app.holds_staff_permission_for('workforce.training.manage', worker_id)
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint
ALTER POLICY training_record_update ON public.training_record
  USING (app.is_system() OR (app.holds_staff_permission_for('workforce.training.manage', worker_id)
    AND worker_id <> app.current_user_id()))
  WITH CHECK (app.is_system() OR (app.holds_staff_permission_for('workforce.training.manage', worker_id)
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint
ALTER POLICY revalidation_evidence_insert ON public.revalidation_evidence
  WITH CHECK (app.is_system()
    OR (app.holds_staff_permission_for('workforce.training.manage', worker_id)
        AND worker_id <> app.current_user_id())
    OR (worker_id = app.current_user_id() AND app.holds_staff_permission('workforce.self.read')
      AND NOT confirmation AND review_state IN ('draft', 'submitted')));
--> statement-breakpoint
ALTER POLICY revalidation_evidence_update ON public.revalidation_evidence
  USING (app.is_system()
    OR ((app.holds_staff_permission_for('workforce.training.manage', worker_id)
        OR app.holds_staff_permission_for('workforce.supervision.manage', worker_id))
      AND worker_id <> app.current_user_id())
    OR (worker_id = app.current_user_id() AND app.holds_staff_permission('workforce.self.read')))
  WITH CHECK (app.is_system()
    OR ((app.holds_staff_permission_for('workforce.training.manage', worker_id)
        OR app.holds_staff_permission_for('workforce.supervision.manage', worker_id))
      AND worker_id <> app.current_user_id())
    OR (worker_id = app.current_user_id() AND app.holds_staff_permission('workforce.self.read')));
--> statement-breakpoint
ALTER POLICY supervision_record_insert ON public.supervision_record
  WITH CHECK (app.is_system() OR (app.holds_staff_permission_for('workforce.supervision.manage', worker_id)
    AND worker_id <> app.current_user_id() AND held_by = app.current_user_id()));
--> statement-breakpoint
ALTER POLICY supervision_record_update ON public.supervision_record
  USING (app.is_system() OR (app.holds_staff_permission_for('workforce.supervision.manage', worker_id)
    AND worker_id <> app.current_user_id() AND held_by = app.current_user_id()))
  WITH CHECK (app.is_system() OR (app.holds_staff_permission_for('workforce.supervision.manage', worker_id)
    AND worker_id <> app.current_user_id() AND held_by = app.current_user_id()));
--> statement-breakpoint
ALTER POLICY competence_sign_off_insert ON public.competence_sign_off
  WITH CHECK (app.is_system() OR (app.holds_staff_permission_for('workforce.competence.observe', worker_id)
    AND observer_id = app.current_user_id() AND worker_id <> app.current_user_id()
    AND observed_on <= (now() AT TIME ZONE 'Europe/London')::date));
--> statement-breakpoint
ALTER POLICY competence_withdrawal_insert ON public.competence_withdrawal
  WITH CHECK (app.is_system() OR (
    (app.holds_staff_permission_for('workforce.competence.observe', app.sign_off_worker(sign_off_id))
      OR app.holds_staff_permission_for('workforce.training.manage', app.sign_off_worker(sign_off_id)))
    AND withdrawn_by = app.current_user_id()
    AND app.sign_off_worker(sign_off_id) <> app.current_user_id()));
--> statement-breakpoint
ALTER POLICY document_training_certificate_insert ON public.document
  WITH CHECK (category <> 'training_certificate' OR app.is_system()
    OR (app.holds_staff_permission_for('workforce.training.manage',
          app.training_record_worker(subject_id))
        AND person_id IS NULL
        AND subject_type = 'training_record'
        AND app.training_record_worker(subject_id) <> app.current_user_id()));
--> statement-breakpoint

-- LMS import (migration 0132) is for organisation-wide holders of workforce.training.manage only:
-- its learner links and rows name members across every home.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lms_source', 'lms_course_map', 'lms_learner_link', 'lms_import',
      'lms_import_row'] LOOP
    EXECUTE format(
      'ALTER POLICY lms_training_manage ON public.%I '
      'USING (app.is_system() OR app.holds_staff_permission_everywhere(''workforce.training.manage'')) '
      'WITH CHECK (app.is_system() OR app.holds_staff_permission_everywhere(''workforce.training.manage''))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER POLICY record_version_lms ON public.record_version
  USING (table_name NOT IN ('lms_source', 'lms_course_map', 'lms_learner_link', 'lms_import',
      'lms_import_row')
    OR app.is_system() OR app.holds_staff_permission_everywhere('workforce.training.manage'));
--> statement-breakpoint

-- Task visibility (migration 0079): a workforce reminder about a member (source tenant_user, with a
-- development permission required, no person and no location) is visible to a tenant-scoped
-- session, its assignee, or a holder whose scope covers the member; every other task follows
-- app.task_visible_with, unchanged. The cheap columns are tested before the definer is asked. The
-- task never gets a location for this: that would show it to everyone at the home (0008).
CREATE OR REPLACE FUNCTION app.task_visible_for(p_person_id uuid, p_location_id uuid,
  p_assignee uuid, p_required_permission text, p_source_type text, p_source_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_source_type = 'tenant_user' AND p_source_id IS NOT NULL
         AND p_person_id IS NULL AND p_location_id IS NULL
         AND p_required_permission IN ('workforce.training.manage', 'workforce.competence.observe',
           'workforce.supervision.manage', 'workforce.staff_file.read')
      THEN app.task_visible(NULL, NULL, p_assignee)
        OR app.holds_staff_permission_for(p_required_permission, p_source_id)
    ELSE app.task_visible_with(p_person_id, p_location_id, p_assignee, p_required_permission)
  END
$$;
--> statement-breakpoint
ALTER POLICY task_scope ON public.task_series
  USING (app.task_visible_for(person_id, location_id, assignee_tenant_user_id, required_permission,
    source_type, source_id))
  WITH CHECK (app.task_visible_for(person_id, location_id, assignee_tenant_user_id,
    required_permission, source_type, source_id));
--> statement-breakpoint
ALTER POLICY task_scope ON public.task
  USING (app.task_visible_for(person_id, location_id, assignee_tenant_user_id, required_permission,
    source_type, source_id))
  WITH CHECK (app.task_visible_for(person_id, location_id, assignee_tenant_user_id,
    required_permission, source_type, source_id));
