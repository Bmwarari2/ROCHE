-- The member lifecycle, completed (H-566; platform.md, Members; built on migration 0129). Three
-- times on the member row: when its status last changed, when the member asked for their account
-- to be deleted, and when their sign-in was erased. app.change_membership (still the only function
-- that changes a member's status or sign-in link) now records them, and lets the erasure sweep,
-- as the system, remove the link of an ended membership whose sign-in is due for erasure: the
-- member asked, that membership has ended, and no membership of the sign-in in an onboarding or
-- active organisation is invited, active or suspended, and it is not a Harbour operator's.
ALTER TABLE "tenant_user" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "sign_in_erasure_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "sign_in_erased_at" timestamp with time zone;--> statement-breakpoint

GRANT SELECT (sign_in_erasure_requested_at, sign_in_erased_at, status_changed_at),
  UPDATE (status_changed_at, sign_in_erased_at) ON public.tenant_user TO harbour_member_owner;
--> statement-breakpoint
GRANT SELECT (id, status) ON public.tenant TO harbour_member_owner;
--> statement-breakpoint
CREATE POLICY member_owner_tenant_status ON public.tenant AS PERMISSIVE FOR SELECT
  TO harbour_member_owner USING (true);
--> statement-breakpoint
GRANT SELECT (auth_user_id) ON public.operator_user TO harbour_member_owner;
--> statement-breakpoint
CREATE POLICY member_owner_operator_check ON public.operator_user AS PERMISSIVE FOR SELECT
  TO harbour_member_owner USING (true);
--> statement-breakpoint
-- The application role writes none of the three times itself: the member's own request goes
-- through app.request_sign_in_erasure, the others through app.change_membership. It keeps UPDATE
-- on every other column (status and the sign-in link stay held by migration 0129's policy).
REVOKE UPDATE ON public.tenant_user FROM harbour_app;
--> statement-breakpoint
GRANT UPDATE (auth_user_id, display_name, email, job_title, status, is_agency, mfa_required,
  last_seen_at, updated_at, updated_by, version, deleted_at) ON public.tenant_user TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_member_owner;
--> statement-breakpoint
SET ROLE harbour_member_owner;
--> statement-breakpoint

-- Whether a sign-in is due for erasure (see above). Internal: called by this role's functions.
CREATE OR REPLACE FUNCTION app.sign_in_erasure_due(p_auth_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_auth_user_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.tenant_user tu
                WHERE tu.auth_user_id = p_auth_user_id AND tu.deleted_at IS NULL
                  AND tu.status = 'left' AND tu.sign_in_erasure_requested_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM public.tenant_user o
                      JOIN public.tenant t ON t.id = o.tenant_id
                    WHERE o.auth_user_id = p_auth_user_id AND o.deleted_at IS NULL
                      AND o.status IN ('invited', 'active', 'suspended')
                      AND t.status IN ('onboarding', 'active'))
    AND NOT EXISTS (SELECT 1 FROM public.operator_user op WHERE op.auth_user_id = p_auth_user_id)
$$;
--> statement-breakpoint

-- The ended memberships whose sign-in is due for erasure, across organisations, for the worker's
-- sweep: opaque ids only. The membership that asked comes last, so a sweep stopped part-way still
-- finds the sign-in due next time.
CREATE OR REPLACE FUNCTION app.sign_ins_due_for_erasure()
RETURNS TABLE (tenant_id uuid, tenant_user_id uuid, auth_user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT tu.tenant_id, tu.id, tu.auth_user_id FROM public.tenant_user tu
  WHERE tu.auth_user_id IS NOT NULL AND tu.deleted_at IS NULL AND tu.status = 'left'
    AND app.sign_in_erasure_due(tu.auth_user_id)
  ORDER BY tu.auth_user_id, (tu.sign_in_erasure_requested_at IS NOT NULL), tu.tenant_id, tu.id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.change_membership(p_member uuid, p_action text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_me uuid := app.current_user_id();
  v_actor_status text;
  v_status text;
  v_auth text;
BEGIN
  -- The erasure sweep (H-566, migration 0153): as the system, with no member, it may only remove
  -- the link of an ended membership whose sign-in is due for erasure.
  IF v_tenant IS NOT NULL AND v_me IS NULL AND app.is_system()
     AND p_action = 'unlink_sign_in' AND p_member IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_tenant::text || ':membership_change'));
    SELECT tu.status::text, tu.auth_user_id INTO v_status, v_auth FROM public.tenant_user tu
     WHERE tu.tenant_id = v_tenant AND tu.id = p_member AND tu.deleted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_auth IS NULL THEN
      RETURN 'unchanged';
    END IF;
    IF v_status <> 'left' OR NOT app.sign_in_erasure_due(v_auth) THEN
      RAISE EXCEPTION 'sign_in_in_use' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user SET auth_user_id = NULL, sign_in_erased_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
    RETURN v_status;
  END IF;
  IF v_tenant IS NULL OR v_me IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('suspend', 'reinstate', 'end', 'unlink_sign_in') THEN
    RAISE EXCEPTION 'unknown_action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_member IS NULL THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_member = v_me THEN
    RAISE EXCEPTION 'own_membership' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app.holds_permission_anywhere('platform.user.manage') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant::text || ':membership_change'));
  PERFORM 1 FROM public.tenant_user tu
   WHERE tu.tenant_id = v_tenant AND tu.id IN (v_me, p_member)
   ORDER BY tu.id
   FOR UPDATE;
  SELECT tu.status::text INTO v_actor_status FROM public.tenant_user tu
   WHERE tu.tenant_id = v_tenant AND tu.id = v_me AND tu.deleted_at IS NULL;
  IF v_actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT tu.status::text, tu.auth_user_id INTO v_status, v_auth FROM public.tenant_user tu
   WHERE tu.tenant_id = v_tenant AND tu.id = p_member AND tu.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_action = 'suspend' THEN
    IF v_status = 'suspended' THEN
      RETURN 'unchanged';
    END IF;
    IF v_status = 'left' THEN
      RAISE EXCEPTION 'membership_ended' USING ERRCODE = 'check_violation';
    END IF;
    IF v_status = 'active' AND EXISTS (
         SELECT 1 FROM public.role_assignment ra
           JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
          WHERE ra.tenant_id = v_tenant AND ra.tenant_user_id = p_member
            AND ra.deleted_at IS NULL AND r.deleted_at IS NULL AND r.archived_at IS NULL
            AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
            AND 'platform.user.manage' = ANY (r.permissions))
       AND NOT EXISTS (
         SELECT 1 FROM public.role_assignment ra
           JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
           JOIN public.tenant_user u ON u.tenant_id = ra.tenant_id AND u.id = ra.tenant_user_id
          WHERE ra.tenant_id = v_tenant AND ra.tenant_user_id <> p_member
            AND u.status = 'active' AND u.deleted_at IS NULL
            AND ra.deleted_at IS NULL AND r.deleted_at IS NULL AND r.archived_at IS NULL
            AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
            AND 'platform.user.manage' = ANY (r.permissions)) THEN
      RAISE EXCEPTION 'last_user_manager' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user SET status = 'suspended', status_changed_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSIF p_action = 'reinstate' THEN
    IF v_status IN ('invited', 'active') THEN
      RETURN 'unchanged';
    END IF;
    IF v_status <> 'suspended' THEN
      RAISE EXCEPTION 'membership_ended' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user
       SET status = CASE WHEN v_auth IS NULL THEN 'invited' ELSE 'active' END::public.tenant_user_status,
           status_changed_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSIF p_action = 'end' THEN
    IF v_status = 'left' THEN
      RETURN 'unchanged';
    END IF;
    IF v_status <> 'suspended' THEN
      RAISE EXCEPTION 'suspend_first' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user SET status = 'left', status_changed_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSIF p_action = 'unlink_sign_in' THEN
    IF v_status <> 'left' THEN
      RAISE EXCEPTION 'membership_not_ended' USING ERRCODE = 'check_violation';
    END IF;
    IF v_auth IS NULL THEN
      RETURN 'unchanged';
    END IF;
    UPDATE public.tenant_user SET auth_user_id = NULL, sign_in_erased_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSE
    RAISE EXCEPTION 'unknown_action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_status;
END
$$;
--> statement-breakpoint
-- Set as their owner, so the revoke takes effect (ADR-0002).
REVOKE ALL ON FUNCTION app.sign_in_erasure_due(text), app.sign_ins_due_for_erasure() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sign_ins_due_for_erasure() TO harbour_worker;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_member_owner;
--> statement-breakpoint

-- The member's own request (MOB-011): the session's member, their own row, once.
CREATE OR REPLACE FUNCTION app.request_sign_in_erasure() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.tenant_user SET sign_in_erasure_requested_at = now()
   WHERE tenant_id = app.current_tenant_id() AND id = app.current_user_id()
     AND sign_in_erasure_requested_at IS NULL;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.request_sign_in_erasure() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.request_sign_in_erasure() TO harbour_app;
