-- Workforce permission findings (workforce guides' review, 07/11/2026; workforce.md section 3,
-- rules 8 and 20). Both tables keep forced row-level security and their tenant policy.

-- 1. The Care Certificate (rule 20): the observation in practice is recorded only by a holder of
-- workforce.competence.observe, the permission meant for observing competence, and needs no staff
-- file permission. The only update this table takes is the observation (the guard of migration
-- 0091 fixes everything else), so the update policy now names that permission alone, as the API
-- does; it used to admit holders of workforce.staff_file.manage too, leaving the guard to refuse
-- them. Knowledge assessments (inserts) stay with .manage or the observer.
DROP POLICY care_certificate_observe ON public.care_certificate_progress;
--> statement-breakpoint
CREATE POLICY care_certificate_observe ON public.care_certificate_progress AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.is_system()
    OR (app.holds_staff_permission('workforce.competence.observe')
        AND app.staff_profile_worker(staff_profile_id) IS DISTINCT FROM app.current_user_id()))
  WITH CHECK (app.is_system()
    OR (app.holds_staff_permission('workforce.competence.observe')
        AND app.staff_profile_worker(staff_profile_id) IS DISTINCT FROM app.current_user_id()));
--> statement-breakpoint

-- An observer may not read staff files, yet must find a worker's Care Certificate from the
-- worker's training record: the staff profile of a member, answered (as app.staff_profile_worker
-- answers the reverse) only for the session's organisation and only to the system, the member,
-- or holders of the staff file or observe permissions; null to anyone else.
CREATE OR REPLACE FUNCTION app.care_certificate_profile(p_member uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.id FROM public.staff_profile p
   WHERE p.tenant_id = app.current_tenant_id() AND p.tenant_user_id = p_member
     AND p.deleted_at IS NULL
     AND (app.is_system() OR p_member = app.current_user_id()
       OR app.holds_staff_permission('workforce.staff_file.read')
       OR app.holds_staff_permission('workforce.staff_file.manage')
       OR app.holds_staff_permission('workforce.competence.observe'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.care_certificate_profile(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.care_certificate_profile(uuid) TO harbour_app;
--> statement-breakpoint
-- The new owner needs CREATE on the schema for the change of owner only (as migration 0151).
GRANT CREATE ON SCHEMA app TO harbour_workforce_definer;
--> statement-breakpoint
ALTER FUNCTION app.care_certificate_profile(uuid) OWNER TO harbour_workforce_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_workforce_definer;
--> statement-breakpoint

-- 2. NMC revalidation (rule 8, H-693), separation of duties: HR (workforce.training.manage) names
-- the confirmer (confirmer_id, migration 0153), never the nurse and never themselves; only the
-- named confirmer, acting for themselves, records the confirmation, after HR's review. HR keeps
-- the rest of the planner and may still take a confirmation back. Existing confirmations stay
-- as recorded: each was already in its confirmer's own name.
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
