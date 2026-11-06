-- The member lifecycle (H-566; platform.md, Member lifecycle): a holder of platform.user.manage
-- suspends a membership, then ends it; once the member who asked for their account to be deleted
-- has had that membership ended and holds no invited, active or suspended membership anywhere,
-- their sign-in identity is erased. The member row, display name and job title stay, so care
-- records remain attributable (Regulation 17).
ALTER TABLE "tenant_user" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "sign_in_erasure_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "sign_in_erased_at" timestamp with time zone;--> statement-breakpoint

-- The application never writes a membership's state, sign-in link or lifecycle times directly:
-- only the definer functions below and the invitation and leaver functions do (security review
-- of H-566, L3). Every other column keeps its UPDATE.
REVOKE UPDATE ON public.tenant_user FROM harbour_app;
--> statement-breakpoint
GRANT UPDATE (display_name, email, job_title, is_agency, mfa_required, last_seen_at, updated_at,
  updated_by, version, deleted_at) ON public.tenant_user TO harbour_app;
--> statement-breakpoint

-- An ended membership stays ended, and an erased row never takes a sign-in again or loses the
-- record of its erasure, whoever writes (a new membership is a new invitation).
CREATE OR REPLACE FUNCTION app.tenant_user_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'left' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'An ended membership stays ended'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.sign_in_erased_at IS NOT NULL AND NEW.sign_in_erased_at IS NULL THEN
    RAISE EXCEPTION 'The record of an erased sign-in stays'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.sign_in_erased_at IS NOT NULL AND OLD.auth_user_id IS NULL
     AND NEW.auth_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'A membership whose sign-in was erased takes no sign-in again'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_user_status_guard BEFORE UPDATE ON public.tenant_user
  FOR EACH ROW EXECUTE FUNCTION app.tenant_user_status_guard();
--> statement-breakpoint

-- Suspends (from active) or ends (from suspended) a membership for a holder of
-- platform.user.manage; the API has already checked that the permission reaches the member
-- (ADR-0071), the step-up and the held entries. Never the caller's own membership, never the
-- organisation's last active member who manages users (two managers suspending each other are
-- serialised on the organisation). Ending also ends the member's roles and grants. Returns the
-- status it found: the same status as asked is a replay and changes nothing.
CREATE OR REPLACE FUNCTION app.change_member_status(p_member uuid, p_to text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_from text;
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL
     OR NOT app.holds_role_permission_somewhere('platform.user.manage') THEN
    RAISE EXCEPTION 'Changing a membership needs platform.user.manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to NOT IN ('suspended', 'left') THEN
    RAISE EXCEPTION 'A membership is suspended or ended here' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_member = app.current_user_id() THEN
    RAISE EXCEPTION 'Nobody changes their own membership' USING ERRCODE = 'HB566';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(app.current_tenant_id()::text || ':member_status'));
  SELECT u.status::text INTO v_from FROM public.tenant_user u
   WHERE u.tenant_id = app.current_tenant_id() AND u.id = p_member AND u.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such member' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_from = p_to THEN
    RETURN v_from;
  END IF;
  IF (p_to = 'suspended' AND v_from <> 'active') OR (p_to = 'left' AND v_from <> 'suspended') THEN
    RAISE EXCEPTION 'A membership is suspended from active and ended from suspended'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_to = 'suspended' AND EXISTS (
       SELECT 1 FROM public.role_assignment ra
         JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = p_member
          AND ra.deleted_at IS NULL AND ra.valid_from <= now()
          AND (ra.valid_to IS NULL OR ra.valid_to > now())
          AND 'platform.user.manage' = ANY (r.permissions))
     AND NOT EXISTS (
       SELECT 1 FROM public.role_assignment ra
         JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
         JOIN public.tenant_user u ON u.tenant_id = ra.tenant_id AND u.id = ra.tenant_user_id
        WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id <> p_member
          AND u.status = 'active' AND u.deleted_at IS NULL
          AND ra.deleted_at IS NULL AND ra.valid_from <= now()
          AND (ra.valid_to IS NULL OR ra.valid_to > now())
          AND 'platform.user.manage' = ANY (r.permissions)) THEN
    RAISE EXCEPTION 'The organisation''s last member who manages users keeps their access'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.tenant_user SET status = p_to::public.tenant_user_status, status_changed_at = now()
   WHERE tenant_id = app.current_tenant_id() AND id = p_member;
  IF p_to = 'left' THEN
    UPDATE public.role_assignment SET valid_to = now()
     WHERE tenant_id = app.current_tenant_id() AND tenant_user_id = p_member
       AND deleted_at IS NULL AND (valid_to IS NULL OR valid_to > now());
    UPDATE public.access_grant SET revoked_at = now()
     WHERE tenant_id = app.current_tenant_id() AND tenant_user_id = p_member
       AND revoked_at IS NULL;
  END IF;
  RETURN v_from;
END
$$;
--> statement-breakpoint

-- The session's member records that they asked for their account to be deleted (MOB-011): only
-- their own row, once.
CREATE OR REPLACE FUNCTION app.request_sign_in_erasure() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Only a member asks for their own account to be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.tenant_user SET sign_in_erasure_requested_at = now()
   WHERE tenant_id = app.current_tenant_id() AND id = app.current_user_id()
     AND sign_in_erasure_requested_at IS NULL;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

-- The erasure step in one organisation, as the system (H-566): first every membership of the
-- sign-in is marked (`sign_in_erased_at`), so a run stopped part-way is found and finished; after
-- the sign-in is deleted each is unlinked, and an ended one's address replaced by an opaque
-- placeholder. True when the row changed.
CREATE OR REPLACE FUNCTION app.mark_sign_in_erased(p_member uuid, p_auth_user_id text,
  p_unlink boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.current_tenant_id() IS NULL OR NOT app.is_system() THEN
    RAISE EXCEPTION 'Only the system erases a sign-in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_unlink THEN
    -- Only a row marked first (security review N1).
    UPDATE public.tenant_user u
       SET auth_user_id = NULL,
           email = CASE WHEN u.status = 'left' THEN u.id::text || '@erased.invalid' ELSE u.email END
     WHERE u.tenant_id = app.current_tenant_id() AND u.id = p_member
       AND u.auth_user_id = p_auth_user_id AND u.sign_in_erased_at IS NOT NULL;
  ELSE
    -- Only a sign-in due for erasure is marked (security review N1).
    IF NOT app.sign_in_due_for_erasure(p_auth_user_id) THEN
      RAISE EXCEPTION 'This sign-in is not due for erasure'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    UPDATE public.tenant_user u SET sign_in_erased_at = now()
     WHERE u.tenant_id = app.current_tenant_id() AND u.id = p_member
       AND u.auth_user_id = p_auth_user_id AND u.sign_in_erased_at IS NULL;
  END IF;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.change_member_status(uuid, text), app.request_sign_in_erasure(),
  app.mark_sign_in_erased(uuid, text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.change_member_status(uuid, text), app.request_sign_in_erasure(),
  app.mark_sign_in_erased(uuid, text, boolean) TO harbour_app;
--> statement-breakpoint

-- Whether a sign-in is due for erasure. Never an operator's, and never while a membership of the
-- sign-in in an onboarding or active organisation is invited or active. Then: an erasure already
-- begun (a membership marked while still linked) is finished; otherwise a membership that asked has
-- been ended and none is suspended in such an organisation (a suspension elsewhere may yet be ended
-- or reinstated there: H-1392, H-1393). An erasure begun and then overtaken by a new membership
-- waits, its mark kept, until that membership ends too (security review N1).
CREATE OR REPLACE FUNCTION app.sign_in_due_for_erasure(p_auth_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.operator_user op WHERE op.auth_user_id = p_auth_user_id)
    AND NOT EXISTS (SELECT 1 FROM public.tenant_user o
                      JOIN public.tenant t ON t.id = o.tenant_id
                    WHERE o.auth_user_id = p_auth_user_id AND o.deleted_at IS NULL
                      AND o.status IN ('invited', 'active')
                      AND t.status IN ('onboarding', 'active'))
    AND (
      EXISTS (SELECT 1 FROM public.tenant_user tu
              WHERE tu.auth_user_id = p_auth_user_id AND tu.deleted_at IS NULL
                AND tu.sign_in_erased_at IS NOT NULL)
      OR (EXISTS (SELECT 1 FROM public.tenant_user tu
                  WHERE tu.auth_user_id = p_auth_user_id AND tu.deleted_at IS NULL
                    AND tu.sign_in_erasure_requested_at IS NOT NULL AND tu.status = 'left')
          AND NOT EXISTS (SELECT 1 FROM public.tenant_user o
                            JOIN public.tenant t ON t.id = o.tenant_id
                          WHERE o.auth_user_id = p_auth_user_id AND o.deleted_at IS NULL
                            AND o.status = 'suspended'
                            AND t.status IN ('onboarding', 'active'))))
$$;
--> statement-breakpoint

-- Every sign-in due for erasure (the worker's sweep).
CREATE OR REPLACE FUNCTION app.sign_ins_due_for_erasure() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT tu.auth_user_id FROM public.tenant_user tu
  WHERE tu.auth_user_id IS NOT NULL AND tu.deleted_at IS NULL
    AND (tu.sign_in_erasure_requested_at IS NOT NULL OR tu.sign_in_erased_at IS NOT NULL)
    AND app.sign_in_due_for_erasure(tu.auth_user_id)
$$;
--> statement-breakpoint

-- The memberships the erasure step acts on: only for a sign-in due for erasure. Opaque ids only.
CREATE OR REPLACE FUNCTION app.memberships_of_sign_in(p_auth_user_id text)
RETURNS TABLE (tenant_id uuid, tenant_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT tu.tenant_id, tu.id FROM public.tenant_user tu
  WHERE tu.auth_user_id = p_auth_user_id AND tu.deleted_at IS NULL
    AND app.sign_in_due_for_erasure(p_auth_user_id)
  ORDER BY tu.tenant_id, tu.id
$$;
--> statement-breakpoint

-- The states of the sign-in's memberships in other onboarding or active organisations (H-354:
-- whether ending its sessions would end work elsewhere). States only, never which organisation.
CREATE OR REPLACE FUNCTION app.other_membership_states(p_auth_user_id text, p_tenant_id uuid)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT tu.status::text FROM public.tenant_user tu
    JOIN public.tenant t ON t.id = tu.tenant_id
  WHERE tu.auth_user_id = p_auth_user_id AND tu.tenant_id <> p_tenant_id
    AND tu.deleted_at IS NULL AND t.status IN ('onboarding', 'active')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sign_in_due_for_erasure(text), app.sign_ins_due_for_erasure(),
  app.memberships_of_sign_in(text), app.other_membership_states(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sign_in_due_for_erasure(text), app.memberships_of_sign_in(text),
  app.other_membership_states(text, uuid) TO harbour_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sign_ins_due_for_erasure() TO harbour_worker;
--> statement-breakpoint
GRANT SELECT (auth_user_id) ON public.operator_user TO harbour_membership_reader;
--> statement-breakpoint
CREATE POLICY membership_reader_operator_check ON public.operator_user AS PERMISSIVE FOR SELECT
  TO harbour_membership_reader USING (true);
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_membership_reader;
--> statement-breakpoint
ALTER FUNCTION app.sign_in_due_for_erasure(text) OWNER TO harbour_membership_reader;
--> statement-breakpoint
ALTER FUNCTION app.sign_ins_due_for_erasure() OWNER TO harbour_membership_reader;
--> statement-breakpoint
ALTER FUNCTION app.memberships_of_sign_in(text) OWNER TO harbour_membership_reader;
--> statement-breakpoint
ALTER FUNCTION app.other_membership_states(text, uuid) OWNER TO harbour_membership_reader;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_membership_reader;
