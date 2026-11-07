-- Security-definer functions owned by NOLOGIN roles only (ADR-0133; security review of batch 3a).
-- Thirty-two definer functions were owned by harbour_owner, the migrator, which can log in and
-- owns every table: a flaw in any of them ran with every table's rights. Each now belongs to a
-- NOLOGIN role for its bounded context, holding only what its functions use:
-- harbour_platform_definer, harbour_care_definer, harbour_workforce_definer,
-- harbour_scheduling_definer and harbour_finance_definer (created by `pnpm db:bootstrap`, as every
-- role is). Each joins every restrictive policy harbour_owner is held by, so it sees no more than
-- harbour_owner did; harbour_owner keeps owning the tables and running migrations. Every definer
-- function's search_path is pinned with pg_temp last, so no temporary object can shadow a name.
-- packages/db/test/definer-acls.test.ts fails if a definer is owned by a role that can log in, or
-- a superuser, or lacks that search_path.

-- harbour_platform_definer: provision_tenant, audit_event_chain.
GRANT USAGE ON SCHEMA public, app TO harbour_platform_definer;
--> statement-breakpoint
GRANT INSERT ON public.record_version TO harbour_platform_definer;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.role, public.role_assignment, public.tenant, public.tenant_user TO harbour_platform_definer;
--> statement-breakpoint
-- What the row-level policies of those tables call, evaluated as this role.
GRANT EXECUTE ON FUNCTION app.agency_access_open(uuid,uuid) TO harbour_platform_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_is_agency(uuid) TO harbour_platform_definer;
--> statement-breakpoint

-- harbour_care_definer: admit_handed_over_entry, care_plan_earlier_plan, refresh_earlier_plan, task_earlier_plan, task_from_earlier_plan, task_series_earlier_plan, seed_discard_reasons, seed_tenant_discard_reasons.
GRANT USAGE ON SCHEMA public, app TO harbour_care_definer;
--> statement-breakpoint
GRANT SELECT ON public.care_plan, public.care_plan_action, public.handover, public.task_series, public.tenant TO harbour_care_definer;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.discard_reason, public.handed_over_entry TO harbour_care_definer;
--> statement-breakpoint
GRANT INSERT ON public.record_version TO harbour_care_definer;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.task TO harbour_care_definer;
--> statement-breakpoint
-- What the row-level policies and triggers of those tables read, evaluated as this role.
GRANT SELECT ON public.access_grant, public.location, public.person, public.person_assignment, public.role, public.role_assignment TO harbour_care_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.agency_access_open(uuid,uuid) TO harbour_care_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_permission_at(text,uuid) TO harbour_care_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_role_permission_at(text,uuid) TO harbour_care_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_role_permission_somewhere(text) TO harbour_care_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_is_agency(uuid) TO harbour_care_definer;
--> statement-breakpoint

-- harbour_workforce_definer: absence_member, casework_for_subject_access, casework_member, employee_case_open, end_leaver_access, equality_monitoring_counts, induction_policy_signing, open_employee_case, operator_appoint_case_manager, staff_profile_worker, supervises_member, supervision_in_force, end_relinked_leaver_access.
GRANT USAGE ON SCHEMA public, app TO harbour_workforce_definer;
--> statement-breakpoint
GRANT SELECT ON public.absence, public.equality_monitoring, public.location, public.policy_signature, public.policy_version, public.role, public.staff_profile, public.supervision_record, public.vacancy TO harbour_workforce_definer;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.access_grant, public.casework_support_ticket, public.leaver_record, public.role_assignment, public.tenant_user TO harbour_workforce_definer;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.employee_case, public.employee_case_event, public.employee_case_member TO harbour_workforce_definer;
--> statement-breakpoint
GRANT INSERT ON public.record_version TO harbour_workforce_definer;
--> statement-breakpoint
-- What the row-level policies and triggers of those tables read, evaluated as this role.
GRANT SELECT ON public.agency, public.incident, public.interview, public.investigation TO harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.agency_access_open(uuid,uuid) TO harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_permission_at(text,uuid) TO harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_role_permission_at(text,uuid) TO harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_role_permission_somewhere(text) TO harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_self_permission(text) TO harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_is_agency(uuid) TO harbour_workforce_definer;
--> statement-breakpoint

-- harbour_scheduling_definer: agency_access_open, agency_assignment_booked, agency_member_role_guard, agency_worker_guard, member_is_agency, raise_cover_need, reads_worker_time, raise_hr_cover_need.
GRANT USAGE ON SCHEMA public, app TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT SELECT ON public.absence, public.access_grant, public.agency, public.agency_worker, public.role, public.role_assignment, public.shift_assignment TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.agency_booking, public.shift, public.tenant_user TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT INSERT ON public.record_version TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.shift_cover_need TO harbour_scheduling_definer;
--> statement-breakpoint
-- What the row-level policies and triggers of those tables read, evaluated as this role.
GRANT SELECT ON public.location, public.rate_table, public.rota, public.shift_template TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_permission_at(text,uuid) TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_role_permission_at(text,uuid) TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_role_permission_somewhere(text) TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_self_permission(text) TO harbour_scheduling_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reads_rota(uuid) TO harbour_scheduling_definer;
--> statement-breakpoint

-- harbour_finance_definer: has_locked_pay_line, pay_run_calculation, pay_run_status.
GRANT USAGE ON SCHEMA public, app TO harbour_finance_definer;
--> statement-breakpoint
GRANT SELECT ON public.pay_run, public.pay_run_line TO harbour_finance_definer;
--> statement-breakpoint

-- The audit chain (app.audit_event_chain, on every audit event).
GRANT SELECT, INSERT, UPDATE ON app.audit_chain_head TO harbour_platform_definer;
--> statement-breakpoint

-- Held by every restrictive policy harbour_owner is held by, so each new owner sees no more than
-- harbour_owner did.
DO $$
DECLARE
  p record;
  v_roles text;
BEGIN
  FOR p IN
    SELECT pol.polname, pol.polrelid::regclass AS rel,
           array(SELECT quote_ident(r.rolname) FROM pg_roles r
                  WHERE r.oid = ANY (pol.polroles) ORDER BY r.rolname) AS roles
      FROM pg_policy pol
     WHERE NOT pol.polpermissive
       AND 'harbour_owner'::regrole::oid = ANY (pol.polroles)
  LOOP
    SELECT string_agg(x, ', ') INTO v_roles FROM (
      SELECT DISTINCT unnest(p.roles || ARRAY['harbour_platform_definer', 'harbour_care_definer',
        'harbour_workforce_definer', 'harbour_scheduling_definer', 'harbour_finance_definer']) AS x
    ) s;
    EXECUTE format('ALTER POLICY %I ON %s TO %s', p.polname, p.rel, v_roles);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Every Harbour definer function's search_path pinned with pg_temp last, keeping the schemas it
-- already names, as its owner (only an owner may alter a function; harbour_owner may act as each
-- NOLOGIN owner, ADR-0002). Extension members (pgAudit's event-trigger functions, a hosting
-- platform's own) and other schemas are not Harbour's to change, and their owners are not roles
-- harbour_owner may act as.
DO $$
DECLARE
  f record;
  v_path text;
  v_usage boolean;
  v_switch boolean;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig, r.rolname AS owner, n.nspname AS nsp,
           (SELECT substr(c, length('search_path=') + 1) FROM unnest(p.proconfig) c
             WHERE c LIKE 'search_path=%') AS path
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.prosecdef AND n.nspname IN ('app', 'public', 'auth')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    -- The schemas it names, in order, without pg_temp; then pg_temp last.
    SELECT string_agg(s, ', ' ORDER BY i) INTO v_path
      FROM unnest(string_to_array(coalesce(f.path, 'pg_catalog, public'), ',')) WITH ORDINALITY AS x(s0, i),
           LATERAL (SELECT btrim(x.s0) AS s) t
     WHERE t.s <> 'pg_temp' AND t.s <> '';
    v_path := coalesce(v_path, 'pg_catalog') || ', pg_temp';
    CONTINUE WHEN f.path = v_path;
    -- An owner without USAGE on the function's schema gets it only for the change.
    v_usage := has_schema_privilege(f.owner, f.nsp, 'USAGE');
    IF NOT v_usage THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', f.nsp, f.owner);
    END IF;
    v_switch := f.owner <> current_user;
    IF v_switch THEN
      EXECUTE format('SET ROLE %I', f.owner);
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = %s', f.sig, v_path);
    IF v_switch THEN
      RESET ROLE;
    END IF;
    IF NOT v_usage THEN
      EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM %I', f.nsp, f.owner);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- The leaver record's guard (migration 0091) let only app.end_leaver_access's owner mark access
-- ended, by name: it now names the new owner too. Otherwise unchanged.
CREATE OR REPLACE FUNCTION app.leaver_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.current_user_id() IS NOT NULL
       AND (NEW.access_removed_at IS NOT NULL OR NEW.access_removed_by IS NOT NULL
            OR NEW.exit_interview <> 'not_offered' OR NEW.exit_interview_on IS NOT NULL
            OR NEW.exit_interview_summary IS NOT NULL) THEN
      RAISE EXCEPTION 'A leaving is recorded with access and the exit interview still to come'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.staff_profile_id, NEW.leaving_on, NEW.reason, NEW.deleted_at)
     IS DISTINCT FROM (OLD.staff_profile_id, OLD.leaving_on, OLD.reason, OLD.deleted_at)
     AND app.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'A leaving keeps its member, date and reason'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Access is marked ended only by app.end_leaver_access (running as its owner,
  -- harbour_workforce_definer since migration 0154), which ends it; harbour_owner for maintenance.
  IF (NEW.access_removed_at, NEW.access_removed_by)
       IS DISTINCT FROM (OLD.access_removed_at, OLD.access_removed_by)
     AND current_user NOT IN ('harbour_owner', 'harbour_workforce_definer') THEN
    RAISE EXCEPTION 'Access is ended through app.end_leaver_access'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.access_removed_at IS NOT NULL
     AND (NEW.access_removed_at, NEW.access_removed_by)
         IS DISTINCT FROM (OLD.access_removed_at, OLD.access_removed_by) THEN
    RAISE EXCEPTION 'Access, once ended, stays ended'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.exit_interview IS DISTINCT FROM OLD.exit_interview AND NOT (
       (OLD.exit_interview = 'not_offered' AND NEW.exit_interview IN ('offered', 'declined', 'held'))
       OR (OLD.exit_interview = 'offered' AND NEW.exit_interview IN ('declined', 'held'))) THEN
    RAISE EXCEPTION 'The exit interview only moves forward'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.exit_interview IN ('declined', 'held')
     AND (NEW.exit_interview_on, NEW.exit_interview_summary)
         IS DISTINCT FROM (OLD.exit_interview_on, OLD.exit_interview_summary) THEN
    RAISE EXCEPTION 'A held exit interview is recorded once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Ownership last, once each owner holds what its functions need. Execute rights stay as granted.
-- A new owner needs CREATE on the schema for the change only (ADR-0002).
GRANT CREATE ON SCHEMA app TO harbour_platform_definer, harbour_care_definer, harbour_workforce_definer,
  harbour_scheduling_definer, harbour_finance_definer;
--> statement-breakpoint
ALTER FUNCTION app.provision_tenant(jsonb,jsonb,jsonb) OWNER TO harbour_platform_definer;
--> statement-breakpoint
ALTER FUNCTION app.audit_event_chain() OWNER TO harbour_platform_definer;
--> statement-breakpoint
ALTER FUNCTION app.admit_handed_over_entry(uuid,uuid,uuid,uuid,text,uuid,timestamp with time zone,integer) OWNER TO harbour_care_definer;
--> statement-breakpoint
ALTER FUNCTION app.care_plan_earlier_plan() OWNER TO harbour_care_definer;
--> statement-breakpoint
ALTER FUNCTION app.refresh_earlier_plan(uuid,uuid[]) OWNER TO harbour_care_definer;
--> statement-breakpoint
ALTER FUNCTION app.task_earlier_plan() OWNER TO harbour_care_definer;
--> statement-breakpoint
ALTER FUNCTION app.task_from_earlier_plan(uuid,uuid) OWNER TO harbour_care_definer;
--> statement-breakpoint
ALTER FUNCTION app.task_series_earlier_plan() OWNER TO harbour_care_definer;
--> statement-breakpoint
ALTER FUNCTION app.seed_discard_reasons(uuid) OWNER TO harbour_care_definer;
--> statement-breakpoint
ALTER FUNCTION app.seed_tenant_discard_reasons() OWNER TO harbour_care_definer;
--> statement-breakpoint
ALTER FUNCTION app.absence_member(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.casework_for_subject_access(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.casework_member(uuid,text[]) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.employee_case_open() OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.end_leaver_access(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.end_relinked_leaver_access(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.equality_monitoring_counts(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.induction_policy_signing(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.open_employee_case(text,uuid,text,date) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.operator_appoint_case_manager(uuid,uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.staff_profile_worker(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.supervises_member(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.supervision_in_force(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.agency_access_open(uuid,uuid) OWNER TO harbour_scheduling_definer;
--> statement-breakpoint
ALTER FUNCTION app.agency_assignment_booked() OWNER TO harbour_scheduling_definer;
--> statement-breakpoint
ALTER FUNCTION app.agency_member_role_guard() OWNER TO harbour_scheduling_definer;
--> statement-breakpoint
ALTER FUNCTION app.agency_worker_guard() OWNER TO harbour_scheduling_definer;
--> statement-breakpoint
ALTER FUNCTION app.member_is_agency(uuid) OWNER TO harbour_scheduling_definer;
--> statement-breakpoint
ALTER FUNCTION app.raise_cover_need(uuid,uuid) OWNER TO harbour_scheduling_definer;
--> statement-breakpoint
ALTER FUNCTION app.raise_hr_cover_need(uuid,uuid) OWNER TO harbour_scheduling_definer;
--> statement-breakpoint
ALTER FUNCTION app.reads_worker_time(uuid) OWNER TO harbour_scheduling_definer;
--> statement-breakpoint
ALTER FUNCTION app.has_locked_pay_line(uuid) OWNER TO harbour_finance_definer;
--> statement-breakpoint
ALTER FUNCTION app.pay_run_calculation(uuid) OWNER TO harbour_finance_definer;
--> statement-breakpoint
ALTER FUNCTION app.pay_run_status(uuid) OWNER TO harbour_finance_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_platform_definer, harbour_care_definer, harbour_workforce_definer,
  harbour_scheduling_definer, harbour_finance_definer;

-- harbour_owner keeps calling the functions row-level policies call, so the policies on its own
-- queries (migrations, seeds) still evaluate; granted by each new owner. The actions it never
-- called stay with their API callers alone.
SET ROLE harbour_care_definer;
--> statement-breakpoint
-- Backfills re-seed an organisation's discard reasons as the migrator (migration 0044).
GRANT EXECUTE ON FUNCTION app.seed_discard_reasons(uuid) TO harbour_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE harbour_workforce_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.absence_member(uuid) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.casework_member(uuid,text[]) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.staff_profile_worker(uuid) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.supervises_member(uuid) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.supervision_in_force(uuid) TO harbour_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE harbour_scheduling_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.agency_access_open(uuid,uuid) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_is_agency(uuid) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reads_worker_time(uuid) TO harbour_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE harbour_finance_definer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.has_locked_pay_line(uuid) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.pay_run_calculation(uuid) TO harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.pay_run_status(uuid) TO harbour_owner;
--> statement-breakpoint
RESET ROLE;
