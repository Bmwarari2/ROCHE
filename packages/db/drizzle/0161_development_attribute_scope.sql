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

-- The members, of p_workers, whose development records p_reader reaches with any of
-- p_permissions: all of this organisation's members for an organisation-wide holder (a role with no
-- person scope, a tenant-scoped role, or a role or grant held organisation-wide); otherwise the
-- members who work at a home where the reader holds one of them (a role in force there, or an
-- access grant there), as app.works_at counts working there. One set-based query: the reader's
-- roles and grants are read once. Definer rights: roles, grants and staff profiles are read
-- whatever the caller may see of them. Nobody executes it directly: the definers below, owned by
-- the same role, ask it for the session's member or, for a revalidation confirmer, for the
-- member being named.
CREATE OR REPLACE FUNCTION app.development_scope_members_for(p_reader uuid, p_permissions text[],
  p_workers uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH reader_roles AS (
    SELECT ra.location_id, ra.organisation_wide, r.scope_kind::text AS scope
    FROM public.role_assignment ra
    JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
    WHERE ra.tenant_id = app.current_tenant_id()
      AND ra.tenant_user_id = p_reader
      AND ra.deleted_at IS NULL
      AND r.archived_at IS NULL
      AND ra.valid_from <= now()
      AND (ra.valid_to IS NULL OR ra.valid_to > now())
      AND r.scope_kind::text IN ('tenant', 'location', 'none')
      AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
        'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
      AND r.permissions && p_permissions
  ),
  reader_grants AS (
    SELECT g.location_id, g.organisation_wide
    FROM public.access_grant g
    WHERE g.tenant_id = app.current_tenant_id()
      AND g.tenant_user_id = p_reader
      AND g.deleted_at IS NULL
      AND g.revoked_at IS NULL
      AND g.valid_from <= now()
      AND g.valid_to > now()
      AND g.permissions && p_permissions
  ),
  everywhere AS (
    SELECT EXISTS (SELECT 1 FROM reader_roles
                   WHERE scope = 'none'
                      OR (location_id IS NULL AND (scope = 'tenant' OR organisation_wide)))
        OR EXISTS (SELECT 1 FROM reader_grants WHERE location_id IS NULL AND organisation_wide)
      AS yes
  ),
  homes AS (
    SELECT location_id FROM reader_roles
     WHERE scope IN ('tenant', 'location') AND location_id IS NOT NULL
    UNION
    SELECT location_id FROM reader_grants WHERE location_id IS NOT NULL
  )
  SELECT tu.id
  FROM public.tenant_user tu
  WHERE p_reader IS NOT NULL
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
REVOKE ALL ON FUNCTION app.development_scope_members_for(uuid, text[], uuid[]) FROM PUBLIC;
--> statement-breakpoint
-- The same for the session's member: what the row-level policies and the API ask.
CREATE OR REPLACE FUNCTION app.development_scope_members(p_permissions text[], p_workers uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m FROM app.development_scope_members_for(app.current_user_id(), p_permissions, p_workers) AS m
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

-- HZ-119: whether a member's competence was withdrawn after a day. Its only caller is the
-- sign-off guard (app.competence_sign_off_guard), which asks it with definer rights so it sees every
-- withdrawal whoever inserts the sign-off. Outside a trigger it answers no, so nobody learns of a
-- withdrawal their own read rules hide by calling it directly. Yes or no only.
CREATE OR REPLACE FUNCTION app.competence_withdrawn_after(p_worker uuid, p_competence text,
  p_on date)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_trigger_depth() > 0 AND EXISTS (
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
ALTER FUNCTION app.development_scope_members_for(uuid, text[], uuid[]) OWNER TO harbour_workforce_definer;
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

--> statement-breakpoint

-- A revalidation confirmer's scope covers the nurse (ADR-0136; security review round 2): the
-- confirmation is a write in the nurse's scope, so naming someone who cannot make it is refused
-- when they are named, never discovered at confirmation. These replace 0157's checks for the guard
-- and the API; 0157's one-argument versions stay for the previous release until a later migration
-- removes them.
CREATE OR REPLACE FUNCTION app.member_may_confirm_revalidation(p_member uuid, p_nurse uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app.member_may_confirm_revalidation(p_member)
    AND EXISTS (SELECT 1 FROM app.development_scope_members_for(p_member,
      ARRAY['workforce.training.manage', 'workforce.supervision.manage'], ARRAY[p_nurse]))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.member_may_confirm_revalidation(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_may_confirm_revalidation(uuid, uuid) TO harbour_app;
--> statement-breakpoint
-- The members HR may name as a nurse's confirmer, for the planner's picker: answered only to a
-- holder of workforce.training.manage, empty to anyone else.
CREATE OR REPLACE FUNCTION app.revalidation_confirmer_candidates(p_nurse uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT tu.id FROM public.tenant_user tu
   WHERE tu.tenant_id = app.current_tenant_id()
     AND app.holds_staff_permission('workforce.training.manage')
     AND app.member_may_confirm_revalidation(tu.id, p_nurse)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.revalidation_confirmer_candidates(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.revalidation_confirmer_candidates(uuid) TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.member_may_confirm_revalidation(uuid, uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.revalidation_confirmer_candidates(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_workforce_definer;
--> statement-breakpoint
-- 0157's guard, asking the two-argument check.
CREATE OR REPLACE FUNCTION app.revalidation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  me uuid := app.current_user_id();
  hr boolean := app.holds_staff_permission('workforce.training.manage');
  was_confirmed boolean := TG_OP = 'UPDATE' AND OLD.confirmation;
  was_state text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.review_state ELSE 'draft' END;
  was_named uuid := CASE WHEN TG_OP = 'UPDATE' THEN OLD.confirmer_id END;
  confirmation_changed boolean := TG_OP = 'UPDATE' AND (
    NEW.confirmation IS DISTINCT FROM OLD.confirmation
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmed_on IS DISTINCT FROM OLD.confirmed_on);
  confirmer_changed boolean := NEW.confirmer_id IS DISTINCT FROM was_named;
  counts_changed boolean := TG_OP = 'INSERT' OR (
    NEW.practice_hours, NEW.cpd_hours, NEW.participatory_cpd_hours, NEW.feedback_pieces,
    NEW.reflective_accounts, NEW.reflective_discussion, NEW.health_and_character,
    NEW.professional_indemnity, NEW.cycle_due_on, NEW.review_state, NEW.reviewed_by,
    NEW.reviewed_at)
  IS DISTINCT FROM (
    OLD.practice_hours, OLD.cpd_hours, OLD.participatory_cpd_hours, OLD.feedback_pieces,
    OLD.reflective_accounts, OLD.reflective_discussion, OLD.health_and_character,
    OLD.professional_indemnity, OLD.cycle_due_on, OLD.review_state, OLD.reviewed_by,
    OLD.reviewed_at);
BEGIN
  -- No bypass for the system: nothing writes revalidation evidence without a member (security
  -- review of the recommended answers, finding 5).
  IF me IS NULL THEN
    RAISE EXCEPTION 'revalidation_needs_a_member' USING ERRCODE = 'check_violation';
  END IF;
  -- Review and confirmation are separate duties (security review, advisory a): whoever reviewed
  -- a cycle is never its confirmer, whichever is recorded first.
  IF NEW.confirmer_id IS NOT NULL AND NEW.confirmer_id = NEW.reviewed_by THEN
    RAISE EXCEPTION 'revalidation_reviewer_cannot_confirm' USING ERRCODE = 'check_violation';
  END IF;
  -- The nurse never touches the confirmation or the confirmer, nor writes once reviewed.
  IF me = NEW.worker_id THEN
    IF NEW.confirmation OR confirmation_changed OR confirmer_changed
        OR NEW.review_state = 'reviewed' OR was_state = 'reviewed' THEN
      RAISE EXCEPTION 'revalidation_nurse_cannot' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Someone confirming without HR rights changes the confirmation only (a line manager).
  IF NOT hr AND counts_changed THEN
    RAISE EXCEPTION 'revalidation_confirmer_confirms_only' USING ERRCODE = 'check_violation';
  END IF;
  -- HR names the confirmer: never themselves, and never once confirmed.
  IF confirmer_changed AND (NOT hr OR NEW.confirmer_id = me OR was_confirmed
      OR NEW.confirmation) THEN
    RAISE EXCEPTION 'revalidation_confirmer_named_by_hr' USING ERRCODE = 'check_violation';
  END IF;
  -- Only someone who may confirm (HR or a line manager), whose scope covers the nurse, is named
  -- (advisory b; ADR-0136).
  IF confirmer_changed AND NEW.confirmer_id IS NOT NULL
     AND NOT app.member_may_confirm_revalidation(NEW.confirmer_id, NEW.worker_id) THEN
    RAISE EXCEPTION 'revalidation_confirmer_not_permitted' USING ERRCODE = 'check_violation';
  END IF;
  -- The confirmation is the named confirmer's, in their own name, after the review; only HR
  -- takes one back.
  IF NEW.confirmation AND NOT was_confirmed THEN
    IF TG_OP = 'INSERT' OR was_named IS DISTINCT FROM me OR NEW.confirmed_by IS DISTINCT FROM me
        OR NEW.review_state <> 'reviewed' THEN
      RAISE EXCEPTION 'revalidation_confirmer_not_you' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF confirmation_changed AND NOT (was_confirmed AND NOT NEW.confirmation AND hr) THEN
    RAISE EXCEPTION 'revalidation_confirmation_fixed' USING ERRCODE = 'check_violation';
  END IF;
  -- HR reviews someone else's evidence, in their own name.
  IF NEW.review_state = 'reviewed' AND was_state <> 'reviewed' THEN
    IF NOT hr OR NEW.reviewed_by IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'revalidation_reviewer_not_you' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Once reviewed, the counts are fixed: only the confirmer and the confirmation may follow.
  IF TG_OP = 'UPDATE' AND OLD.review_state = 'reviewed' AND counts_changed THEN
    RAISE EXCEPTION 'revalidation_reviewed_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
